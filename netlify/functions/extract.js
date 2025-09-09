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

/* Ricavi CE A)1) – scelta POSIZIONALE: numero più vicino alla colonna dell'anno più recente */
function extractRicaviVendite(text) {
  const all = (text || "").replace(/\u00A0/g, " ");
  const lines = all.split(/\r?\n/);

  // 1) Header con due date e posizioni di colonna
  let dateLeft = null, dateRight = null;
  let colLeft = 0, colRight = 0;
  const reDates = /(\d{2}[-\.]\d{2}[-\.](\d{4}))/g;

  for (const L of lines) {
    const mDates = [...L.matchAll(reDates)];
    if (mDates.length >= 2 && /CONTO\s+ECONOMICO/i.test(L)) {
      const d1 = mDates[0][1], y1 = parseInt(mDates[0][2], 10), p1 = L.indexOf(d1);
      const d2 = mDates[1][1], y2 = parseInt(mDates[1][2], 10), p2 = L.indexOf(d2);
      if (p1 <= p2) { dateLeft = {year:y1};  colLeft = p1; dateRight = {year:y2}; colRight = p2; }
      else          { dateLeft = {year:y2};  colLeft = p2; dateRight = {year:y1}; colRight = p1; }
      break;
    }
  }
  if (!dateLeft || !dateRight) return legacyRicaviVendite(all); // fallback se non trovo l'header

  const useLeft   = dateLeft.year >= dateRight.year;   // anno più recente
  const targetCol = useLeft ? colLeft : colRight;

  // helper: trova TUTTI i numeri sulla riga e sceglie quello con centro più vicino a targetCol
  const reNum = /(\d{1,3}(?:[.\s]\d{3})*(?:,\d+)?|\d{4,}(?:,\d+)?)/g; // niente "1" secco
  const closestOnLine = (L) => {
    let best = null, bestDist = Infinity;
    for (const m of L.matchAll(reNum)) {
      const token = m[1];
      const n = toNum(token);
      if (!Number.isFinite(n) || n === 0) continue;
      const start = m.index ?? L.indexOf(token);
      const center = start + token.length / 2;
      const dist = Math.abs(center - targetCol);
      if (dist < bestDist) { bestDist = dist; best = n; }
    }
    return best; // null se niente
  };

  // 2) Prendi la riga della voce "1) Ricavi ..."
  const rowIdx = lines.findIndex(l => /1\)\s*Ricavi\s+delle\s+vendite\s+e\s+delle\s+prestazioni/i.test(l));
  if (rowIdx === -1) return legacyRicaviVendite(all);

  // 3) Prova sulla riga e poi su 1-2 righe sotto, ma scegli SEMPRE il numero più vicino alla colonna
  for (let off = 0; off <= 2; off++) {
    const i = rowIdx + off;
    if (i >= lines.length) break;
    const candidate = closestOnLine(lines[i]);
    if (Number.isFinite(candidate)) return candidate;
  }

  // 4) Fallback finale
  return legacyRicaviVendite(all);
}

/* Fallback regex "storico" */
function legacyRicaviVendite(t) {
  let m = t.match(/1\)\s*Ricavi\s+delle\s+vendite\s+e\s+delle\s+prestazioni[^\d\-]*([0-9\.\s,]+)\s+([0-9\.\s,]+)/i);
  if (m) return toNum(m[1]);
  m = t.match(/A\)\s*VALORE\s+DELLA\s+PRODUZIONE[^]*?1\)\s*R[^\n]*?([0-9\.\s,]+)\s+([0-9\.\s,]+)/ims);
  if (m) return toNum(m[1]);
  m = t.match(/(^|\n)\s*1\)\s*Ricavi\s+delle\s+vendite\s+e\s+delle\s+prestazioni[^\d\-]*([0-9\.\s,]+)\b/ims);
  if (m) return toNum(m[2]);
  m = t.match(/1\)\s*Ricavi\s+delle\s+vendite\s+e\s+delle\s+prestazioni[^\n]*\n\s*([0-9\.\s,]+)\b/ims);
  if (m) return toNum(m[1]);
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
      ? "ATTENZIONE: 'fatturato' = Conto Economico voce «A) 1) Ricavi delle vendite e delle prestazioni». Se sulla riga sono presenti più esercizi (es. 2024 e 2023), restituisci SOLO l'importo dell'anno più recente (la colonna più recente/di sinistra). NON usare il 'Totale valore della produzione'."
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