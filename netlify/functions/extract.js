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

/* Ricavi CE A)1) – prendi SOLO l'importo dell'anno più recente, ignorando il "1)" della voce */
/* Ricavi CE A)1) – lettura POSIZIONALE: prende SOLO l'importo della colonna dell'anno più recente */
function extractRicaviVendite(text) {
  const all = (text || "").replace(/\u00A0/g, " ");
  const lines = all.split(/\r?\n/);

  // 1) Individua l'header con le due date e salva le colonne
  //    Copre sia "31-12-2024" che "31.12.2024"
  let headerIdx = -1;
  let dateLeft = null, dateRight = null;
  let colLeft = 0, colRight = 0; // indici di colonna (posizione carattere nella riga)

  const dateRe = /(\d{2}[-\.]\d{2}[-\.](\d{4}))/g;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const m = [...L.matchAll(dateRe)];
    if (m.length >= 2 && /CONTO\s+ECONOMICO/i.test(L)) {
      // prendi le prime due date trovate e le loro posizioni
      const d1 = m[0][1], y1 = parseInt(m[0][2], 10), p1 = L.indexOf(d1);
      const d2 = m[1][1], y2 = parseInt(m[1][2], 10), p2 = L.indexOf(d2);
      // ordina sinistra/destra
      if (p1 <= p2) {
        dateLeft = { str: d1, year: y1 };  colLeft = p1;
        dateRight = { str: d2, year: y2 }; colRight = p2;
      } else {
        dateLeft = { str: d2, year: y2 };  colLeft = p2;
        dateRight = { str: d1, year: y1 }; colRight = p1;
      }
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1 || !dateLeft || !dateRight) {
    // se non trovo header, passo al vecchio metodo "pattern"
    return legacyRicaviVendite(all);
  }

  // quale colonna è l'anno più recente?
  const useLeft = dateLeft.year >= dateRight.year; // spesso l'anno più recente è a sinistra
  const targetCol = useLeft ? colLeft : colRight;

  // helper: estrae un "numero" da un segmento di testo
  const toNumLocal = (s) => {
    if (!s) return NaN;
    const cleaned = s.replace(/[^\d.,\s]/g, "").replace(/\s+/g, " ").trim();
    // prendi il PRIMO token numerico con migliaia/decimali (così eviti il semplice "1" della voce)
    const token = cleaned.match(/(\d{1,3}(?:[.\s]\d{3})*(?:,\d+)?|\d{4,}(?:,\d+)?)/);
    if (!token) return NaN;
    return toNum(token[1]);
  };

  // 2) Trova la riga "1) Ricavi delle vendite e delle prestazioni"
  const rowIdx = lines.findIndex(l => /1\)\s*Ricavi\s+delle\s+vendite\s+e\s+delle\s+prestazioni/i.test(l));
  if (rowIdx === -1) return legacyRicaviVendite(all);

  // 3) Prova sulla stessa riga e poi su 1-2 righe successive (alcuni PDF mettono i numeri sotto)
  for (let off = 0; off <= 2; off++) {
    const i = rowIdx + off;
    if (i >= lines.length) break;
    const L = lines[i];

    // prendi una "finestra" attorno alla colonna target (evita di leggere il "1)" a sinistra)
    const start = Math.max(0, targetCol - 10);
    const end = Math.min(L.length, targetCol + 20);
    const slice = L.slice(start, end);

    const val = toNumLocal(slice);
    if (Number.isFinite(val) && val > 0) return val;
  }

  // 4) Se ancora niente, ripiega al vecchio estrattore regex (comunque robusto)
  return legacyRicaviVendite(all);
}

/* Estrattore "legacy" (regex) come fallback finale */
function legacyRicaviVendite(t) {
  // prova due numeri sulla stessa riga
  let m = t.match(/1\)\s*Ricavi\s+delle\s+vendite\s+e\s+delle\s+prestazioni[^\d\-]*([0-9\.\s,]+)\s+([0-9\.\s,]+)/i);
  if (m) {
    // senza header non so quale anno sia più recente: prendo il PRIMO
    return toNum(m[1]);
  }
  // variante più lasca
  m = t.match(/A\)\s*VALORE\s+DELLA\s+PRODUZIONE[^]*?1\)\s*R[^\n]*?([0-9\.\s,]+)\s+([0-9\.\s,]+)/ims);
  if (m) return toNum(m[1]);

  // singolo numero dopo la voce
  m = t.match(/(^|\n)\s*1\)\s*Ricavi\s+delle\s+vendite\s+e\s+delle\s+prestazioni[^\d\-]*([0-9\.\s,]+)\b/ims);
  if (m) return toNum(m[2]);

  // numero sulla riga successiva
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