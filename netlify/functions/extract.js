// netlify/functions/extract.js
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

/* --- Regex helper --- */
function extractVisura(text) {
  const out = { ragioneSociale: "", codiceFiscale: "" };
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  let den =
    (text.match(/Denominazione:\s*(.+)/i)?.[1] ?? "") ||
    lines.find(l => /SOCIET[AÀ]'?|\bS\.?R\.?L\.?\b|\bSRLS?\b|\bS\.?P\.?A\.?\b/i.test(l)) ||
    "";
  if (den) out.ragioneSociale = den.replace(/\s{2,}/g, " ").trim();

  const cfMatch =
    text.match(/Codice\s*fiscale[^0-9]*([0-9]{11})/i) ||
    text.match(/Partita\s*IVA[^0-9]*([0-9]{11})/i) ||
    text.match(/\b([0-9]{11})\b/);
  if (cfMatch) out.codiceFiscale = cfMatch[1];

  return out;
}

function toNum(v) {
  if (v == null) return 0;
  const s = String(v).replace(/[€\s]/g, "").replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

async function callOpenAIForJSON({ text, hint, fields }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY non configurata");

  const snippet = (text || "").slice(0, 18000);

  // fields: array di chiavi richieste (es. ["ragioneSociale","codiceFiscale"])
  const schema = fields.reduce((acc, k) => { acc[k] = (k === "attivo" || k === "fatturato") ? 0 : ""; return acc; }, {});
  const schemaStr = JSON.stringify(schema);

  const system = "Estrai in JSON i campi richiesti dal testo (visure/bilanci italiani). Se un campo richiesto non è presente, restituisci 0 o stringa vuota. NON inventare campi non richiesti.";
  const user = `Testo (${hint}):
"""${snippet}"""

Ritorna SOLO questi campi (JSON esatto):
${schemaStr}`;

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
  try { return JSON.parse(content); } catch { return schema; }
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

    let result = { ragioneSociale:"", codiceFiscale:"", attivo:0, fatturato:0, ula:0 };

    if (kind === "visura") {
      // Solo Ragione/CF
      const rx = extractVisura(text);
      result.ragioneSociale = rx.ragioneSociale || "";
      result.codiceFiscale = rx.codiceFiscale || "";
      // Se mancano, tenta LLM solo per quei 2 campi
      if (!result.ragioneSociale || !result.codiceFiscale) {
        try {
          const ai = await callOpenAIForJSON({ text, hint: kind, fields: ["ragioneSociale","codiceFiscale"] });
          result.ragioneSociale ||= (ai.ragioneSociale || "");
          result.codiceFiscale ||= (ai.codiceFiscale || "");
        } catch (e) { /* ignora fallback */ }
      }
      // attivo/fatturato restano 0
    } else if (kind === "bilancio") {
      // Solo Attivo/Fatturato via LLM (i numeri nei bilanci variano molto di layout)
      try {
        const ai = await callOpenAIForJSON({ text, hint: kind, fields: ["attivo","fatturato"] });
        result.attivo = toNum(ai.attivo);
        result.fatturato = toNum(ai.fatturato);
      } catch (e) { /* ignora fallback */ }
      // ragione/cf lasciati vuoti
    } else {
      // Fallback generico: tenta tutto
      // 1) visura basic
      const rx = extractVisura(text);
      result.ragioneSociale = rx.ragioneSociale || "";
      result.codiceFiscale = rx.codiceFiscale || "";
      // 2) ai per numeri
      try {
        const ai = await callOpenAIForJSON({ text, hint: kind, fields: ["ragioneSociale","codiceFiscale","attivo","fatturato"] });
        result.ragioneSociale ||= (ai.ragioneSociale || "");
        result.codiceFiscale ||= (ai.codiceFiscale || "");
        result.attivo = result.attivo || toNum(ai.attivo);
        result.fatturato = result.fatturato || toNum(ai.fatturato);
      } catch (e) { /* ignora fallback */ }
    }

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(result) };
  } catch (err) {
    console.error("EXTRACT ERROR:", err);
    return { statusCode: 500, body: "Errore durante l'estrazione" };
  }
};