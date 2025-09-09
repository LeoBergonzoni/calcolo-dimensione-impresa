// netlify/functions/extract.js
const { Buffer } = require("node:buffer");
const Busboy = require("busboy");
const pdf = require("pdf-parse");

/* ---------- multipart ---------- */
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

/* ---------- helpers ---------- */
function toNum(v) {
  if (v == null) return 0;
  const s = String(v)
    .replace(/[€\s]/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function extractVisura(text) {
  const out = { ragioneSociale: "", codiceFiscale: "" };
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  let den =
    (text.match(/Denominazione:\s*(.+)/i)?.[1] ?? "") ||
    lines.find((l) =>
      /SOCIET[AÀ]'?|\bS\.?R\.?L\.?\b|\bSRLS?\b|\bS\.?P\.?A\.?\b/i.test(l)
    ) ||
    "";
  if (den) out.ragioneSociale = den.replace(/\s{2,}/g, " ").trim();

  const cfMatch =
    text.match(/Codice\s*fiscale[^0-9]*([0-9]{11})/i) ||
    text.match(/Partita\s*IVA[^0-9]*([0-9]{11})/i) ||
    text.match(/\b([0-9]{11})\b/);
  if (cfMatch) out.codiceFiscale = cfMatch[1];

  return out;
}

/* Ricavi CE A)1) - regex abbastanza robusta su PDF testuali */
function extractRicaviVendite(text) {
  const t = text.replace(/\u00A0/g, " ");
  // Casi frequenti: “A) Valore della produzione … 1) Ricavi delle vendite e delle prestazioni … 1.234.567”
  const rx1 =
    /A\)\s*VALORE\s+DELLA\s+PRODUZIONE[^]*?1\)\s*R(ICAVI|\.)[^0-9\-]*([0-9\.\s,]+)\b/ims;
  const m1 = t.match(rx1);
  if (m1 && m1[2]) return toNum(m1[2]);

  // Altri layout: riga isolata “1) Ricavi delle vendite e delle prestazioni …… 1.234.567”
  const rx2 =
    /(^|\n)\s*1\)\s*Ricavi\s+delle\s+vendite\s+e\s+delle\s+prestazioni[^0-9\-]*([0-9\.\s,]+)\b/ims;
  const m2 = t.match(rx2);
  if (m2 && m2[2]) return toNum(m2[2]);

  // Ultimo tentativo: tabella con numero nella riga successiva
  const rx3 =
    /1\)\s*Ricavi\s+delle\s+vendite\s+e\s+delle\s+prestazioni[^\n]*\n\s*([0-9\.\s,]+)\b/ims;
  const m3 = t.match(rx3);
  if (m3 && m3[1]) return toNum(m3[1]);

  return 0;
}

async function callOpenAIForJSON({ text, kind, fields }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY non configurata");

  const snippet = (text || "").slice(0, 18000);
  const schema = fields.reduce((acc, k) => {
    acc[k] = k === "attivo" || k === "fatturato" ? 0 : "";
    return acc;
  }, {});
  const system =
    "Estrai in JSON i campi richiesti dal testo (visure/bilanci italiani). Non inventare.";
  // Nota pedagogica per il bilancio: fatturato = CE A)1) Ricavi vendite/prestazioni
  const hintBilancio =
    kind === "bilancio"
      ? "ATTENZIONE: 'fatturato' va inteso come Conto Economico voce A)1) Ricavi delle vendite e delle prestazioni (NON il totale valore della produzione) solo relativo alla colonna dell'ultimo anno presente."
      : "";

  const user = `Testo (${kind}):
${hintBilancio}
"""${snippet}"""

Ritorna SOLO questi campi in JSON esatto: ${JSON.stringify(schema)}`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
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
    return schema;
  }
}

/* ---------- handler ---------- */
exports.handler = async (event) => {
  if (event.httpMethod !== "POST")
    return { statusCode: 405, body: "Method Not Allowed" };

  try {
    const { fields, files } = await parseMultipart(event);
    const file = files.file;
    const kind = (fields.kind || "generico").toLowerCase();
    if (!file?.buffer)
      return { statusCode: 400, body: "Nessun file ricevuto" };

    const pdfData = await pdf(file.buffer);
    const text = pdfData.text || "";
    if (!text.trim())
      return { statusCode: 422, body: "PDF senza testo. Serve OCR (scannerizzato)." };

    let result = {
      ragioneSociale: "",
      codiceFiscale: "",
      attivo: 0,
      fatturato: 0,
      ula: 0,
    };

    if (kind === "visura") {
      // Solo anagrafica
      const rx = extractVisura(text);
      result.ragioneSociale = rx.ragioneSociale || "";
      result.codiceFiscale = rx.codiceFiscale || "";
      if (!result.ragioneSociale || !result.codiceFiscale) {
        try {
          const ai = await callOpenAIForJSON({
            text,
            kind,
            fields: ["ragioneSociale", "codiceFiscale"],
          });
          result.ragioneSociale ||= ai.ragioneSociale || "";
          result.codiceFiscale ||= ai.codiceFiscale || "";
        } catch {}
      }
    } else if (kind === "bilancio") {
      // Fatturato = CE A)1) Ricavi vendite/prestazioni
      const ricavi = extractRicaviVendite(text);
      if (ricavi) result.fatturato = ricavi;

      // Attivo dal bilancio (spesso "Totale attivo"): meglio via AI per i layout diversi
      try {
        const ai = await callOpenAIForJSON({
          text,
          kind,
          fields: ["attivo", "fatturato"],
        });
        if (!result.fatturato) result.fatturato = toNum(ai.fatturato);
        result.attivo = toNum(ai.attivo);
      } catch {}
    } else {
      // Fallback
      const rx = extractVisura(text);
      result.ragioneSociale = rx.ragioneSociale || "";
      result.codiceFiscale = rx.codiceFiscale || "";
      const ricavi = extractRicaviVendite(text);
      if (ricavi) result.fatturato = ricavi;

      try {
        const ai = await callOpenAIForJSON({
          text,
          kind,
          fields: ["ragioneSociale", "codiceFiscale", "attivo", "fatturato"],
        });
        result.ragioneSociale ||= ai.ragioneSociale || "";
        result.codiceFiscale ||= ai.codiceFiscale || "";
        if (!result.fatturato) result.fatturato = toNum(ai.fatturato);
        result.attivo = result.attivo || toNum(ai.attivo);
      } catch {}
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
    };
  } catch (err) {
    console.error("EXTRACT ERROR:", err);
    return { statusCode: 500, body: "Errore durante l'estrazione" };
  }
};