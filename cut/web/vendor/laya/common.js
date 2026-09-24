function pyJson(v) {
    if (v === null) return "null";
    if (typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
    if (typeof v === "number") {
        if (Number.isNaN(v)) return "NaN";
        if (v === Infinity) return "Infinity";
        if (v === -Infinity) return "-Infinity";
        return JSON.stringify(v);
    }
    if (Array.isArray(v)) return `[${v.map((x)=>pyJson(x) ?? "null").join(", ")}]`;
    if (typeof v === "object") {
        const proto = Object.getPrototypeOf(v);
        if (proto !== Object.prototype && proto !== null) return undefined;
        const parts = [];
        for (const [k, x] of Object.entries(v)){
            const s = pyJson(x);
            if (s !== undefined) parts.push(`${JSON.stringify(k)}: ${s}`);
        }
        return `{${parts.join(", ")}}`;
    }
    return undefined;
}
export function serializeState(state) {
    if (typeof state === "string") return state;
    return pyJson(state) ?? String(state);
}
function renderCriterion(v) {
    return typeof v === "string" ? v : pyJson(v) ?? String(v);
}
export function renderOptions(q) {
    if (q.t === "choice") {
        const crit = q.crit;
        return Object.entries(crit).map(([k, v])=>v === null || v === undefined || v === "" ? k : `${k}: ${renderCriterion(v)}`);
    }
    if (q.t === "score") {
        return q.crit.map((c, i)=>`level ${i}: ${renderCriterion(c)}`);
    }
    const crit = q.crit ?? {};
    const labels = q.labels ?? {
        false: "false",
        true: "true"
    };
    const f = crit["false"], t = crit["true"];
    return [
        labels.false + ": " + (f !== null && f !== undefined && f !== "" ? renderCriterion(f) : "no, the statement does not hold"),
        labels.true + ": " + (t !== null && t !== undefined && t !== "" ? renderCriterion(t) : "yes, the statement holds")
    ];
}
export function buildQuestionPrefix(tok, q, maxLen = 512, headMaxLen = 192, optionOrder) {
    const maskTok = tok.maskToken;
    const opts = renderOptions(q);
    const order = optionOrder ?? opts.map((_, i)=>i);
    const ins = String(q.ins).split(maskTok).join(" ");
    let headIds = tok.encode(`${q.t} question: ${ins}`);
    let optIds = order.map((i)=>[
            tok.maskId,
            ...tok.encode(" " + opts[i].split(maskTok).join(" ")).slice(0, 48)
        ]);
    let budget = headMaxLen - optIds.reduce((a, o)=>a + o.length, 0);
    if (budget < 16) {
        const per = Math.max(4, Math.floor((headMaxLen - 16) / Math.max(1, optIds.length)));
        optIds = optIds.map((o)=>o.slice(0, per));
        budget = headMaxLen - optIds.reduce((a, o)=>a + o.length, 0);
    }
    headIds = headIds.slice(0, Math.max(8, budget));
    const ids = [
        tok.clsId,
        ...headIds,
        tok.sepId
    ];
    const markers = [];
    for (const o of optIds){
        markers.push(ids.length);
        ids.push(...o);
    }
    ids.push(tok.sepId);
    return {
        ids,
        markers,
        nOptions: opts.length
    };
}
export function sequenceWithState(prefix, stateIds, sepId, maxLen = 512, truncateLeft = false) {
    const room = Math.max(0, maxLen - prefix.ids.length - 1);
    const st = truncateLeft ? stateIds.slice(-room) : stateIds.slice(0, room);
    const ids = [
        ...prefix.ids,
        ...st,
        sepId
    ].slice(0, maxLen);
    return {
        ids,
        markers: prefix.markers.filter((m)=>m < maxLen)
    };
}
export function buildSequence(tok, state, q, maxLen = 512, headMaxLen = 192, optionOrder, truncateLeft = false) {
    const stAll = tok.encode(serializeState(state).split(tok.maskToken).join(" "));
    return sequenceWithState(buildQuestionPrefix(tok, q, maxLen, headMaxLen, optionOrder), stAll, tok.sepId, maxLen, truncateLeft);
}
export function softmax(z) {
    const m = Math.max(...z);
    const e = z.map((v)=>Math.exp(v - m));
    const s = e.reduce((a, b)=>a + b, 0);
    return e.map((v)=>v / s);
}
export function confidenceFromProbs(p) {
    const k = p.length;
    if (k < 2) return 1.0;
    const ent = -p.reduce((a, v)=>a + v * Math.log(Math.max(v, 1e-12)), 0);
    return Math.min(1, Math.max(0, 1 - ent / Math.log(k)));
}
export const TEMP_MIN = 0.5, TEMP_MAX = 5.0;
export function clampTemperature(t) {
    if (t === null || t === undefined || t === "" || typeof t === "boolean") return 1.0;
    const f = typeof t === "number" ? t : Number(t);
    if (!Number.isFinite(f)) return 1.0;
    return Math.min(TEMP_MAX, Math.max(TEMP_MIN, f));
}
export function tempBucket(qtype, k) {
    const size = k <= 2 ? "2" : k <= 5 ? "3-5" : k <= 10 ? "6-10" : "11+";
    return `${[
        "choice",
        "score",
        "noul"
    ][qtype]}:${size}`;
}
export function collateItems(batch, padId) {
    const items = (batch ?? []).flat();
    if (items.length === 0) return null;
    const L = Math.max(...items.map((it)=>it.ids.length));
    const K = Math.max(...items.map((it)=>it.markers.length));
    const hasTarget = items.some((it)=>"target" in it);
    const inputIds = items.map((it)=>[
            ...it.ids,
            ...Array(L - it.ids.length).fill(padId)
        ]);
    const attentionMask = items.map((it)=>[
            ...Array(it.ids.length).fill(1),
            ...Array(L - it.ids.length).fill(0)
        ]);
    const markerPos = items.map((it)=>[
            ...it.markers,
            ...Array(K - it.markers.length).fill(0)
        ]);
    const markerMask = items.map((it)=>[
            ...it.markers.map(()=>true),
            ...Array(K - it.markers.length).fill(false)
        ]);
    const qtype = items.map((it)=>it.qtype);
    const label = items.map((it)=>typeof it.label === "number" ? it.label : -1);
    const meta = items.map((it)=>{
        const { ids: _ids, markers: _markers, target: _target, ...m } = it;
        return m;
    });
    const out = {
        inputIds,
        attentionMask,
        markerPos,
        markerMask,
        qtype,
        label,
        meta
    };
    if (hasTarget) {
        out.target = items.map((it, i)=>{
            const t = Array.isArray(it.target) ? it.target : [];
            const k = it.markers.length;
            if (t.length > k) {
                throw new Error(`collateItems: item ${i} has ${t.length} target entries but only ${k} marker positions; ` + "a target needs one entry per option");
            }
            return [
                ...t,
                ...Array(K - t.length).fill(0)
            ];
        });
    }
    return out;
}
