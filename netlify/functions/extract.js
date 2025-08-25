// netlify/functions/extract.js (CommonJS)
const { Buffer } = require("node:buffer");
const Busboy = require("busboy");
const pdf = require("pdf-parse");

async function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(
      Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
    );
    const contentType = headers["content-type"] || headers["content-type".toLowerCase()];
    if (!contentType) return reject(new Error("Content-Type mancante"));

    const bb = Busboy({ headers: { "content-type": contentType } });
    const fields = {};
    const files = {};

    bb.on("file", (name, file, info) => {
      const chunks = [];
      file.on("data", (d) => chunks.push(d));
      file.on("end", () => {
        files[name] = { ...info, buffer: Buffer.concat(chunks) };
      });
    });

    bb.on("field", (name, val) => (fields[name] = val));
    bb.on("error", reject);
    bb.on("close", () => resolve({ fields, files }));

    const body = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64")
      : Buffer.from(event.body || "");
    bb.end(body);
  });
}

async function callOpenAIForJSON({ text, kind }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY non configurata");

  // taglia testo troppo lungo
  const snippet = (text || "").slice(0, 20000);

  const system = "Sei un assistente che estrae campi aziendali da testi di visure o bilanci italiani.";
  const user = `Dal seguente testo estrai i campi:
- ragioneSociale (string)
- codiceFiscale (string)
- attivo (numero in euro, senza separatori di migliaia)
- fatturato (numero in euro, senza separatori di migliaia)
- ula (intero)

Testo (${kind}):
"""${snippet}"""

Rispondi SOLO con JSON valido:
{"ragioneSociale":"","codiceFiscale":"","attivo":0,"fatturato":0,"ula":0}`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI ${res.status}: ${txt}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || "{}";
  try {
    return JSON.parse(content);
  } catch {
    return { ragioneSociale: "", codiceFiscale: "", attivo: 0, fatturato: 0, ula: 0 };
  }
}

function toNum(v) {
  if (v == null) return 0;
  const s = String(v).replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}
function toInt(v) {
  const n = parseInt(String(v).replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { fields, files } = await parseMultipart(event);
    const file = files.file;
    const kind = fields.kind || "generico";
    if (!file?.buffer) {
      return { statusCode: 400, body: "Nessun file ricevuto" };
    }

    // Estrai testo dal PDF
    const pdfData = await pdf(file.buffer);
    const text = pdfData.text || "";

    // Se il PDF non ha testo (scanner) -> errore esplicito
    if (!text.trim()) {
      return { statusCode: 422, body: "PDF senza testo. Serve OCR (scannerizzato)." };
    }

    // Chiamata a OpenAI per normalizzare
    const json = await callOpenAIForJSON({ text, kind });

    const out = {
      ragioneSociale: json.ragioneSociale?.toString().trim() || "",
      codiceFiscale: json.codiceFiscale?.toString().trim() || "",
      attivo: toNum(json.attivo),
      fatturato: toNum(json.fatturato),
      ula: toInt(json.ula),
    };

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(out),
    };
  } catch (err) {
    console.error("EXTRACT ERROR:", err);
    // Invia dettagli minimi per aiutare il debug lato client
    return { statusCode: 500, body: "Errore durante l'estrazione" };
  }
};