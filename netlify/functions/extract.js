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

/* Ricavi CE A)1) - prendi SOLO l'importo dell'anno più recente anche se i numeri sono "attaccati" */
function extractRicaviVendite(text) {
  const t = (text || "").replace(/\u00A0/g, " ");

  // 1) Decidi quale colonna è l'anno più recente leggendo l'header del CE
  //    Esempi: "CONTO ECONOMICO 31-12-2024 31-12-2023" oppure "31.12.2024 31.12.2023"
  let latestIndex = 0; // 0 = prima colonna (sx), 1 = seconda (dx)
  const hdr = t.match(/CONTO\s+ECONOMICO\s+(\d{2}[-\.]\d{2}[-\.](\d{4}))\s+(\d{2}[-\.]\d{2}[-\.](\d{4}))/i);
  if (hdr && hdr[2] && hdr[4]) {
    const y1 = parseInt(hdr[2], 10);
    const y2 = parseInt(hdr[4], 10);
    latestIndex = y1 >= y2 ? 0 : 1; // spesso l'anno più recente è la prima colonna a sx
  }

  // 2) Isola la riga (e, se serve, la successiva) della voce "1) Ricavi delle vendite e delle prestazioni"
  const lineMatch = t.match(/1\)\s*Ricavi\s+delle\s+vendite\s+e\s+delle\s+prestazioni.*(?:\n.*)?/i);
  if (lineMatch) {
    const lineBlock = lineMatch[0];

    // Estrai TUTTI i numeri sul blocco (accetta formati "433.230", "397,471", "433 230")
    const nums = [];
    const reNum = /(?<!\d)(\d(?:[\d\.\s,]*\d)?)(?!\d)/g;
    let m;
    while ((m = reNum.exec(lineBlock)) !== null) {
      // normalizza ogni numero singolarmente (così evitiamo la concatenazione)
      const raw = m[1];
      const n = toNum(raw);
      if (n) nums.push(n);
    }

    // Se ci sono almeno 2 numeri, scegli in base alla colonna "più recente"
    if (nums.length >= 2) return nums[Math.min(latestIndex, nums.length - 1)];
    // Se c'è un solo numero, restituiscilo
    if (nums.length === 1) return nums[0];
  }

  // 3) Fallback: pattern "due colonne" più lasco
  const row2colLoose = t.match(
    /A\)\s*VALORE\s+DELLA\s+PRODUZIONE[^]*?1\)\s*R[^\n]*?([0-9\.\s,]+)\s+([0-9\.\s,]+)/ims
  );
  if (row2colLoose) {
    const pick = row2colLoose[1 + latestIndex];
    return toNum(pick);
  }

  // 4) Layout a una colonna
  const singleCol = t.match(
    /(^|\n)\s*1\)\s*Ricavi\s+delle\s+vendite\s+e\s+delle\s+prestazioni[^\d\-]*([0-9\.\s,]+)\b/ims
  );
  if (singleCol) return toNum(singleCol[2]);

  // 5) Numero su riga successiva
  const nextLine = t.match(
    /1\)\s*Ricavi\s+delle\s+vendite\s+e\s+delle\s+prestazioni[^\n]*\n\s*([0-9\.\s,]+)\b/ims
  );
  if (nextLine) return toNum(nextLine[1]);

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