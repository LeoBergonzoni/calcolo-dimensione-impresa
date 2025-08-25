// netlify/functions/extract.js
import { Buffer } from "node:buffer";
import Busboy from "busboy";
import pdf from "pdf-parse";
import fetch from "node-fetch"; // se usi Node <18; con Node 18+ puoi usare global fetch
export const config = { path: "/.netlify/functions/extract" };

function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const files = {};
    const bb = Busboy({
      headers: {
        "content-type": event.headers["content-type"] || event.headers["Content-Type"],
      },
    });

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
  if (!apiKey) throw new Error("OPENAI_API_KEY non configurata.");

  // Riduci il testo se enorme
  const snippet = text.slice(0, 20000);

  const system = "Sei un assistente che estrae campi aziendali da testo di visure o bilanci italiani.";
  const user = `Dal seguente testo estrai i campi:
- ragioneSociale (string)
- codiceFiscale (string)
- attivo (numero in euro, senza separatori di migliaia)
- fatturato (numero in euro, senza separatori di migliaia)
- ula (intero)

Testo (${kind}):
"""${snippet}"""

Rispondi SOLO con JSON valido con le chiavi esattamente:
{"ragioneSociale":"","codiceFiscale":"","attivo":0,"fatturato":0,"ula":0}`;

  // chat.completions (compatibile, semplice)
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0,
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI error: ${res.status} ${t}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "{}";

  // Prova a fare il parse del JSON
  try {
    return JSON.parse(content);
  } catch {
    // fallback minimale
    return { ragioneSociale: "", codiceFiscale: "", attivo: 0, fatturato: 0, ula: 0 };
  }
}

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { fields, files } = await parseMultipart(event);
    const file = files.file;
    const kind = fields.kind || "generico";
    if (!file?.buffer) return { statusCode: 400, body: "Nessun file ricevuto." };

    // Estrai testo dal PDF
    const pdfData = await pdf(file.buffer);
    const text = pdfData.text || "";

    // Richiesta a OpenAI per normalizzare -> JSON
    const json = await callOpenAIForJSON({ text, kind });

    // Sanitizza numeri (virgole, punti)
    const toNum = (v) => {
      if (v == null) return 0;
      const s = String(v).replace(/\./g, "").replace(",", ".");
      const n = parseFloat(s);
      return Number.isFinite(n) ? n : 0;
    };
    const toInt = (v) => {
      const n = parseInt(String(v).replace(/[^\d-]/g, ""), 10);
      return Number.isFinite(n) ? n : 0;
    };

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
    console.error(err);
    return { statusCode: 500, body: "Errore durante l'estrazione." };
  }
}