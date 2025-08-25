// netlify/functions/extract.js (CommonJS, NO estrazione ULA)
const { Buffer } = require("node:buffer");
const Busboy = require("busboy");
const pdf = require("pdf-parse");

async function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(
      Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
    );
    const contentType = headers["content-type"];
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

/** Estrattori REGEX (senza ULA) */
function extractWithRegex(rawText) {
  const text = (rawText || "").replace(/\r/g, "");
  const out = { ragioneSociale: "", codiceFiscale: "", attivo: 0, fatturato: 0 };

  // Ragione sociale
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  let den =
    (text.match(/Denominazione:\s*(.+)/i)?.[1] ?? "")
    || lines.find(l => /SOCIET[AÀ]'?|\bS\.?R\.?L\.?\b|\bSRLS?\b|\bS\.?P\.?A\.?\b/i.test(l))
    || "";
  if (den) out.ragioneSociale = den.replace(/\s{2,}/g, " ").trim();

  // Codice fiscale (11 cifre) / Partita IVA
  const cfMatch =
    text.match(/Codice\s*fiscale[^0-9]*([0-9]{11})/i) ||
    text.match(/Partita\s*IVA[^0-9]*([0-9]{11})/i) ||
    text.match(/\b([0-9]{11})\b/);
  if (cfMatch) out.codiceFiscale = cfMatch[1];

  // Attivo / Fatturato: spesso non in visura; li lasciamo 0 e li riempie l'LLM se trova nei bilanci
  return out;
}

async function callOpenAIForJSON({ text, hint }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY non configurata");

  const snippet = (text || "").slice(0, 18000);

  const system = "Estrai in JSON i campi aziendali da visure o bilanci italiani. Se un campo non è presente, metti 0 o stringa vuota. NON inventare l'ULA.";
  const user = `Testo (${hint}):
"""${snippet}"""

Ritorna SOLO JSON con chiavi esatte:
{"ragioneSociale":"","codiceFiscale":"","attivo":0,"fatturato":0}`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0
    })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI ${res.status}: ${txt}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || "{}";
  try { return JSON.parse(content); } catch { return { ragioneSociale:"", codiceFiscale:"", attivo:0, fatturato:0 }; }
}

function toNum(v) {
  if (v == null) return 0;
  const s = String(v).replace(/[€\s]/g, "").replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  try {
    const { fields, files } = await parseMultipart(event);
    const file = files.file;
    const kind = (fields.kind || "generico").toLowerCase();
    if (!file?.buffer) return { statusCode: 400, body: "Nessun file ricevuto" };

    const pdfData = await pdf(file.buffer);
    const text = pdfData.text || "";
    if (!text.trim()) return { statusCode: 422, body: "PDF senza testo. Serve OCR (scannerizzato)." };

    // 1) Regex base
    let out = extractWithRegex(text);

    // 2) Completa buchi con LLM (senza ULA)
    if (!out.ragioneSociale || !out.codiceFiscale || (out.attivo === 0 && out.fatturato === 0)) {
      try {
        const ai = await callOpenAIForJSON({ text, hint: kind });
        out = {
          ragioneSociale: out.ragioneSociale || (ai.ragioneSociale || ""),
          codiceFiscale: out.codiceFiscale || (ai.codiceFiscale || ""),
          attivo: out.attivo || toNum(ai.attivo),
          fatturato: out.fatturato || toNum(ai.fatturato)
        };
      } catch (e) {
        console.warn("Fallback LLM non disponibile:", e.message);
      }
    }

    // ULA sempre 0: deve essere inserita manualmente nel frontend
    const result = {
      ragioneSociale: (out.ragioneSociale || "").toString().trim(),
      codiceFiscale: (out.codiceFiscale || "").toString().trim(),
      attivo: toNum(out.attivo),
      fatturato: toNum(out.fatturato),
      ula: 0
    };

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(result) };
  } catch (err) {
    console.error("EXTRACT ERROR:", err);
    return { statusCode: 500, body: "Errore durante l'estrazione" };
  }
};