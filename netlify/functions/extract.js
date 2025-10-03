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
const uniq = (arr)=> Array.from(new Set(arr.filter(Boolean)));

function extractAteco(text) {
  const codes = [];
  // pattern classico 2.2.2 o 2.2 formati
  const re = /\b(\d{2}(?:\.\d{2}(?:\.\d{2})?)?)\b/g;
  let m;
  while((m=re.exec(text))){ codes.push(m[1]); }
  // parole chiave sezione visura
  return uniq(codes);
}

function detectFormaGiuridicaTipo(text) {
  const t = text.toLowerCase();
  // euristiche minime
  if (/\b(s\.?p\.?a\.?|societ[aà] per azioni|s\.?r\.?l\.?|srls|societ[aà] responsabilit[aà] limitata|s\.?a\.?p\.?a\.?)\b/.test(t)) {
    return "capitali";
  }
  if (/\b(s\.?n\.?c\.?|s\.?a\.?s\.?|societ[aà] in nome collettivo|societ[aà] in accomandita semplice)\b/.test(t)) {
    return "persone";
  }
  // fallback su etichette generiche
  if (/societ[aà]\s+di\s+capitali/.test(t)) return "capitali";
  if (/societ[aà]\s+di\s+persone/.test(t)) return "persone";
  return "";
}

function cfTipo(cf) {
  const s = String(cf||'').trim();
  if (/^[0-9]{11}$/.test(s)) return "giuridica"; // CF/P.IVA numerica
  if (/^[A-Z0-9]{16}$/i.test(s)) return "fisica"; // CF persona fisica
  return ""; // ignoto
}

function extractSoci(text){
  const out = [];
  const lines = text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  // blocco soci tipico visura
  const start = lines.findIndex(l=>/Soci\s+e\s+Titolari\s+di\s+diritti\s+su\s+azioni\s+e\s+quote/i.test(l));
  const end = start>=0 ? Math.min(lines.length, start+200) : -1;
  const chunk = start>=0 ? lines.slice(start, end) : lines;
  // euristica: righe che contengono % o "quota"
  chunk.forEach(l=>{
    const mPerc = l.match(/(\d{1,3}(?:[.,]\d+)?)\s*%/);
    if(mPerc){
      const quota = toNum(mPerc[1]);
      // cerca un CF vicino
      const cfMatch = l.match(/\b([A-Z0-9]{16}|[0-9]{11})\b/);
      const cf = cfMatch ? cfMatch[1] : "";
      // nome/denom: prendi porzione testuale prima del CF o fino a "quota"
      let nome = l.replace(/\s{2,}/g,' ').trim();
      if(cf) nome = nome.split(cf)[0].trim();
      nome = nome.replace(/.*?:\s*/,''); // dopo eventuale etichetta
      nome = nome.replace(/\b(quota|percentuale).*$/i,'').trim();
      const tipo = cfTipo(cf) || (/s\.?r\.?l|s\.?p\.?a/i.test(nome) ? "giuridica" : "");
      out.push({ nome, cf, tipo: tipo||'fisica', quota });
    }
  });
  // normalizza e deduplica su cf+nome, mantenendo quota se presente
  const map = new Map();
  out.forEach(s=>{
    const key = (s.cf||'')+'|'+(s.nome||'').toLowerCase();
    if(!map.has(key)) map.set(key, s);
  });
  return Array.from(map.values());
}

function extractVisura(text) {
  const out = { ragioneSociale: "", codiceFiscale: "", formaGiuridicaTipo: "", atecoCodes: [], soci: [] };
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  // Denominazione
  let den =
    (text.match(/Denominazione:\s*(.+)/i)?.[1] ?? "") ||
    lines.find((l) =>
      /SOCIET[AÀ]'?|\bS\.?R\.?L\.?\b|\bSRLS?\b|\bS\.?P\.?A\.?\b/i.test(l)
    ) ||
    "";
  if (den) out.ragioneSociale = den.replace(/\s{2,}/g, " ").trim();

  // CF/P.IVA
  const cfMatch =
    text.match(/Codice\s*fiscale[^0-9A-Z]*([0-9]{11}|[A-Z0-9]{16})/i) ||
    text.match(/Partita\s*IVA[^0-9]*([0-9]{11})/i) ||
    text.match(/\b([0-9]{11}|[A-Z0-9]{16})\b/);
  if (cfMatch) out.codiceFiscale = cfMatch[1];

  // Forma giuridica
  out.formaGiuridicaTipo = detectFormaGiuridicaTipo(text);

  // ATECO
  out.atecoCodes = extractAteco(text);

  // Soci
  out.soci = extractSoci(text);

  return out;
}

/* Ricavi CE A)1) – robusto alle colonne multiple */
function extractRicaviVendite(text) {
  const all = (text || "").replace(/\u00A0/g, " ");
  const lines = all.split(/\r?\n/);

  const isPlausibleToken = (s) => {
    if (!s) return false;
    const hasSep = /[.,]/.test(s);
    const digits = s.replace(/\D/g, "");
    return hasSep || digits.length >= 3; // esclude “1”
  };
  const toTokens = (s) =>
    [...(s || "").matchAll(/(\d{1,3}(?:[.\s]\d{3})*(?:,\d+)?|\d{4,}(?:,\d+)?)/g)].map(m => m[1]);

  const rowIdx = lines.findIndex(l => /1\)\s*Ricavi\s+delle\s+vendite\s+e\s+delle\s+prestazioni/i.test(l));
  if (rowIdx === -1) return legacyRicaviVenditeFiltered(all, isPlausibleToken);

  const candidates = [];
  const row = lines[rowIdx] || "";
  const rowNext = lines[rowIdx + 1] || "";

  const afterLabel = row.replace(/.*1\)\s*Ricavi\s+delle\s+vendite\s+e\s+delle\s+prestazioni/i, " ");
  candidates.push(...toTokens(afterLabel).filter(isPlausibleToken));
  if (candidates.length === 0) {
    candidates.push(...toTokens(rowNext).filter(isPlausibleToken));
  }
  if (candidates.length >= 2) return toNum(candidates[0]);
  if (candidates.length === 1) return toNum(candidates[0]);

  return legacyRicaviVenditeFiltered(all, isPlausibleToken);
}

function legacyRicaviVenditeFiltered(t, isPlausibleToken) {
  let m;
  m = t.match(/1\)\s*Ricavi\s+delle\s+vendite\s+e\s+delle\s+prestazioni[^\n]*?([0-9\.\s,]+)\s+([0-9\.\s,]+)/i);
  if (m) {
    const a = (m[1] || "").trim(), b = (m[2] || "").trim();
    const pick = isPlausibleToken(a) ? a : (isPlausibleToken(b) ? b : "");
    if (pick) return toNum(pick);
  }
  m = t.match(/A\)\s*VALORE\s+DELLA\s+PRODUZIONE[^]*?1\)\s*R[^\n]*?([0-9\.\s,]+)\s+([0-9\.\s,]+)/ims);
  if (m) {
    const a = (m[1] || "").trim(), b = (m[2] || "").trim();
    const pick = isPlausibleToken(a) ? a : (isPlausibleToken(b) ? b : "");
    if (pick) return toNum(pick);
  }
  m = t.match(/(^|\n)\s*1\)\s*Ricavi\s+delle\s+vendite\s+e\s+delle\s+prestazioni[^\d\-]*([0-9\.\s,]+)\b/ims);
  if (m && isPlausibleToken(m[2])) return toNum(m[2]);
  m = t.match(/1\)\s*Ricavi\s+delle\s+vendite\s+e\s+delle\s+prestazioni[^\n]*\n\s*([0-9\.\s,]+)\b/ims);
  if (m && isPlausibleToken(m[1])) return toNum(m[1]);
  return 0;
}

async function callOpenAIForJSON({ text, kind, fields }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY non configurata");

  const snippet = (text || "").slice(0, 18000);
  const schema = fields.reduce((acc, k) => {
    acc[k] = (k === "attivo" || k === "fatturato" || /rs106|rs116|ve50/.test(k)) ? 0 : (k.endsWith("Codes")?[]:"");
    return acc;
  }, {});
  const system =
    "Estrai in JSON i campi richiesti dal testo (visure/bilanci italiani). Non inventare. Se un campo non è presente lascia il valore vuoto o 0.";
  const hintBilancio =
    kind === "bilancio"
      ? "ATTENZIONE: 'fatturato' = Conto Economico voce «A) 1) Ricavi delle vendite e delle prestazioni». Se sulla riga sono presenti più esercizi, restituisci SOLO l'importo dell'anno più recente (colonna più recente/di sinistra). NON usare il 'Totale valore della produzione'."
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

    // base output
    let result = {
      ragioneSociale: "",
      codiceFiscale: "",
      attivo: 0,
      fatturato: 0,
      ula: 0,
      // estensioni
      formaGiuridicaTipo: "",
      atecoCodes: [],
      soci: [],
      rs106_attivo: 0,
      rs116_fatturato: 0,
      ve50_volume: 0,
    };

    if (kind === "visura") {
      const rx = extractVisura(text);
      result = { ...result, ...rx };

      // fallback/riempimento via AI se manca qualcosa
      try {
        const ai = await callOpenAIForJSON({
          text,
          kind,
          fields: ["ragioneSociale", "codiceFiscale", "formaGiuridicaTipo", "atecoCodes"]
        });
        result.ragioneSociale ||= ai.ragioneSociale || "";
        result.codiceFiscale ||= ai.codiceFiscale || "";
        result.formaGiuridicaTipo ||= ai.formaGiuridicaTipo || "";
        if (Array.isArray(ai.atecoCodes) && ai.atecoCodes.length) {
          result.atecoCodes = uniq([...(result.atecoCodes||[]), ...ai.atecoCodes]);
        }
      } catch {}
    } else if (kind === "bilancio") {
      const ricavi = extractRicaviVendite(text);
      if (ricavi) result.fatturato = ricavi;

      try {
        const ai = await callOpenAIForJSON({
          text,
          kind,
          fields: ["attivo", "fatturato"],
        });
        if (!result.fatturato) result.fatturato = toNum(ai.fatturato);
        result.attivo = toNum(ai.attivo);
      } catch {}
    } else if (kind === "redditi") {
      // RS106 attivo – RS116 fatturato
      // regex robuste a spazi/tab
      const rs106 = text.match(/RS106[^\d]*([\d\.\s,]+)/i);
      const rs116 = text.match(/RS116[^\d]*([\d\.\s,]+)/i);
      if (rs106) result.rs106_attivo = toNum(rs106[1]);
      if (rs116) result.rs116_fatturato = toNum(rs116[1]);
      // AI fallback
      try{
        const ai = await callOpenAIForJSON({
          text, kind, fields: ["rs106_attivo","rs116_fatturato"]
        });
        if(!result.rs106_attivo) result.rs106_attivo = toNum(ai.rs106_attivo);
        if(!result.rs116_fatturato) result.rs116_fatturato = toNum(ai.rs116_fatturato);
      }catch{}
    } else if (kind === "iva") {
      // VE50 volume d’affari
      const ve50 = text.match(/VE50[^\d]*([\d\.\s,]+)/i);
      if (ve50) result.ve50_volume = toNum(ve50[1]);
      try{
        const ai = await callOpenAIForJSON({
          text, kind, fields: ["ve50_volume"]
        });
        if(!result.ve50_volume) result.ve50_volume = toNum(ai.ve50_volume);
      }catch{}
    } else {
      // generico: prova a estrarre anagrafica + valori
      const rx = extractVisura(text);
      result.ragioneSociale = rx.ragioneSociale || "";
      result.codiceFiscale = rx.codiceFiscale || "";
      result.formaGiuridicaTipo = rx.formaGiuridicaTipo || "";
      result.atecoCodes = rx.atecoCodes || [];
      result.soci = rx.soci || [];

      const ricavi = extractRicaviVendite(text);
      if (ricavi) result.fatturato = ricavi;

      try {
        const ai = await callOpenAIForJSON({
          text,
          kind,
          fields: ["ragioneSociale", "codiceFiscale", "attivo", "fatturato", "formaGiuridicaTipo", "atecoCodes"],
        });
        result.ragioneSociale ||= ai.ragioneSociale || "";
        result.codiceFiscale ||= ai.codiceFiscale || "";
        if (!result.fatturato) result.fatturato = toNum(ai.fatturato);
        result.attivo = result.attivo || toNum(ai.attivo);
        result.formaGiuridicaTipo ||= ai.formaGiuridicaTipo || "";
        if (Array.isArray(ai.atecoCodes) && ai.atecoCodes.length) {
          result.atecoCodes = uniq([...(result.atecoCodes||[]), ...ai.atecoCodes]);
        }
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