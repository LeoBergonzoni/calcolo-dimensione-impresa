// netlify/functions/extract.js (CommonJS, versione con REGEX + fallback LLM)
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

/** Estrattori REGEX per visure italiane */
function extractWithRegex(rawText, kind) {
  const text = (rawText || "").replace(/\r/g, "");
  const out = { ragioneSociale: "", codiceFiscale: "", attivo: 0, fatturato: 0, ula: 0 };

  // 1) Ragione sociale
  // - linee che contengono "SOCIETA" o "S.R.L." o "SRL" o "SPA" in maiuscolo
  // - oppure "Denominazione: ..."
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  let den =
    (text.match(/Denominazione:\s*(.+)/i)?.[1] ?? "")
    || lines.find(l => /SOCIET[AÀ]'?|\bS\.?R\.?L\.?\b|\bSRLS?\b|\bS\.?P\.?A\.?\b/i.test(l))
    || "";
  if (den) {
    // pulizia spazi multipli
    den = den.replace(/\s{2,}/g, " ").trim();
    out.ragioneSociale = den;
  }

  // 2) Codice fiscale (società: 11 cifre) – priorità a "Codice fiscale ..." o "Partita IVA ..."
  const cfMatch =
    text.match(/Codice\s*fiscale[^0-9]*([0-9]{11})/i) ||
    text.match(/Partita\s*IVA[^0-9]*([0-9]{11})/i) ||
    text.match(/\b([0-9]{11})\b/);
  if (cfMatch) out.codiceFiscale = cfMatch[1];

  // 3) Addetti -> ULA (visure spesso riportano "Addetti 8" oppure tabelle con "Totale 8")
  // Proviamo prima "Addetti ... <numero>" su una sola riga
  const addettiDirect = text.match(/Addetti(?:\s+al[^\n]*)?\s+(\d{1,5})\b/i);
  if (addettiDirect) {
    out.ula = parseInt(addettiDirect[1], 10) || 0;
  } else {
    // fallback: cerca "Totale 8" in sezioni Addetti
    const addettiBlock = text.split(/Addetti[\s\S]*?\n/i)[1] || "";
    const totInBlock = addettiBlock.match(/\bTotale\s+(\d{1,5})\b/i);
    if (totInBlock) out.ula = parseInt(totInBlock[1], 10) || 0;
  }

  // 4) Fatturato e Attivo: in visura spesso NON presenti -> lascio 0; il bilancio/popola più avanti.
  // Se troviamo valori tipo "Capitale sociale" NON li confondiamo con attivo/fatturato.

  // Se è una visura esplicita, non forziamo LLM per attivo/fatturato (tipicamente assenti).
  return out;
}

async function callOpenAIForJSON({ text, hint }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY non configurata");

  const snippet = (text || "").slice(0, 18000); // riduco un po'

  const system = "Estrai in JSON i campi aziendali da visure o bilanci italiani. Se un campo non è presente, metti 0 o stringa vuota.";
  const user = `Testo (${hint}):
"""${snippet}"""

Ritorna SOLO JSON con chiavi esatte:
{"ragioneSociale":"","codiceFiscale":"","attivo":0,"fatturato":0,"ula":0}`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" }, // forza JSON
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
  try { return JSON.parse(content); } catch { return { ragioneSociale:"", codiceFiscale:"", attivo:0, fatturato:0, ula:0 }; }
}

function toNum(v) {
  if (v == null) return 0;
  const s = String(v).replace(/[€\s]/g, "").replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}
function toInt(v) {
  const n = parseInt(String(v).replace(/[^\d-]/g, ""), 10);
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

    // 1) Regex first
    let out = extractWithRegex(text, kind);

    // 2) Se mancano ragione/CF e hai voglia di far tentare il modello, fallo qui:
    if ((!out.ragioneSociale || !out.codiceFiscale) || (kind !== "visura" && (out.attivo === 0 && out.fatturato === 0))) {
      try {
        const ai = await callOpenAIForJSON({ text, hint: kind });
        // Merge: tieni ciò che hai già e completa i buchi
        out = {
          ragioneSociale: out.ragioneSociale || (ai.ragioneSociale || ""),
          codiceFiscale: out.codiceFiscale || (ai.codiceFiscale || ""),
          attivo: out.attivo || toNum(ai.attivo),
          fatturato: out.fatturato || toNum(ai.fatturato),
          ula: out.ula || toInt(ai.ula),
        };
      } catch (e) {
        // Se l'AI fallisce, prosegui con i soli dati regex
        console.warn("Fallback LLM non disponibile:", e.message);
      }
    }

    // Sanitizza finale
    const result = {
      ragioneSociale: (out.ragioneSociale || "").toString().trim(),
      codiceFiscale: (out.codiceFiscale || "").toString().trim(),
      attivo: toNum(out.attivo),
      fatturato: toNum(out.fatturato),
      ula: toInt(out.ula),
    };

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(result) };
  } catch (err) {
    console.error("EXTRACT ERROR:", err);
    return { statusCode: 500, body: "Errore durante l'estrazione" };
  }
};