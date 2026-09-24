import { TEMP_MAX, TEMP_MIN, buildQuestionPrefix, clampTemperature, collateItems, confidenceFromProbs, renderOptions, sequenceWithState, serializeState, softmax, tempBucket } from "./common.js";
import { encodeWithData, parseTokenizerJson } from "./tokenizer.js";
import { HookRegistry, PredictContext, aggregateUsage, composeHooks, dispatch, normaliseHooks } from "./hooks.js";
export const QTYPES = {
    choice: 0,
    score: 1,
    noul: 2
};
function qidStr(qid) {
    return JSON.stringify(qid);
}
export function checkQuestion(qid, qdef) {
    if (typeof qdef !== "object" || qdef === null || Array.isArray(qdef)) {
        const got = Array.isArray(qdef) ? "list" : qdef === null ? "NoneType" : typeof qdef;
        throw new Error(`question ${qidStr(qid)}: definition must be a dict, got ${got}`);
    }
    const q = qdef;
    const t = q["type"];
    if (t !== "choice" && t !== "score" && t !== "noul") {
        throw new Error(`question ${qidStr(qid)}: unknown type ${JSON.stringify(t)}; use one of ${JSON.stringify(Object.keys(QTYPES).sort())}`);
    }
    if (!("instructions" in q)) {
        throw new Error(`question ${qidStr(qid)}: no 'instructions'; add the text the model should answer`);
    }
    const crit = q["criteria"];
    if (t === "choice") {
        if (typeof crit !== "object" || crit === null) {
            throw new Error(`question ${qidStr(qid)}: a choice question takes 'criteria' as a dict of label -> description, or a list of labels`);
        }
        if (Object.keys(crit).length === 0) {
            throw new Error(`question ${qidStr(qid)}: a choice question needs at least one criterion`);
        }
    } else if (t === "score") {
        if (!Array.isArray(crit)) {
            throw new Error(`question ${qidStr(qid)}: a score question takes 'criteria' as a list of level descriptions, index 0 first`);
        }
        if (crit.length === 0) {
            throw new Error(`question ${qidStr(qid)}: a score question needs at least one level`);
        }
    } else if (crit !== undefined && crit !== null && (typeof crit !== "object" || Array.isArray(crit))) {
        throw new Error(`question ${qidStr(qid)}: a noul question takes 'criteria' as a dict with optional 'true'/'false' descriptions, or omits it`);
    } else if (crit && typeof crit === "object" && !Array.isArray(crit)) {
        const invalid = Object.keys(crit).filter((key)=>key !== "true" && key !== "false");
        if (invalid.length > 0) {
            throw new Error(`question ${qidStr(qid)}: noul criteria may contain only 'true' and 'false'; got ${JSON.stringify(invalid)}`);
        }
    }
    if ("labels" in q && t !== "noul") {
        throw new Error(`question ${qidStr(qid)}: 'labels' is only supported for noul questions`);
    }
    if (t === "noul" && "labels" in q) {
        const labels = q["labels"];
        if (typeof labels !== "object" || labels === null || Array.isArray(labels)) {
            throw new Error(`question ${qidStr(qid)}: noul labels must be an object with 'false' and 'true'`);
        }
        const entries = Object.entries(labels);
        const keys = entries.map(([key])=>key).sort();
        if (keys.length !== 2 || keys[0] !== "false" || keys[1] !== "true" || entries.some(([, value])=>typeof value !== "string" || value.trim() === "")) {
            throw new Error(`question ${qidStr(qid)}: noul labels must map exactly 'false' and 'true' to distinct non-empty strings`);
        }
        const falseLabel = String(labels["false"]).trim();
        const trueLabel = String(labels["true"]).trim();
        if (falseLabel === trueLabel) {
            throw new Error(`question ${qidStr(qid)}: noul labels must be distinct`);
        }
    }
}
export function toInternal(qdef) {
    const t = qdef["type"];
    let crit = qdef["criteria"];
    if (t === "choice" && Array.isArray(crit)) {
        crit = Object.fromEntries(crit.map((c)=>[
                c,
                null
            ]));
    } else if (t === "noul" && crit !== null && crit !== undefined && typeof crit === "object" && !Array.isArray(crit)) {
        crit = Object.fromEntries(Object.entries(crit).map(([k, v])=>[
                String(k).toLowerCase(),
                v
            ]));
    }
    let ins = qdef["instructions"];
    if (typeof ins !== "string") ins = serializeState(ins);
    const out = {
        t,
        ins: ins,
        crit
    };
    if (t === "noul" && qdef["labels"] && typeof qdef["labels"] === "object" && !Array.isArray(qdef["labels"])) {
        const labels = qdef["labels"];
        out.labels = {
            false: String(labels["false"]).trim(),
            true: String(labels["true"]).trim()
        };
    }
    return out;
}
export function defaultTokenizer() {
    return {
        clsId: 101,
        sepId: 102,
        maskId: 103,
        padId: 0,
        maskToken: "[MASK]",
        encode (text) {
            return text.split(/\s+/).filter(Boolean).map((w, i)=>1000 + (w.length * 31 + i * 7) % 20000);
        }
    };
}
function tokenizerFromHF(tokenizerJson) {
    const data = parseTokenizerJson(tokenizerJson);
    if (!data) return null;
    return {
        clsId: data.ids.cls,
        sepId: data.ids.sep,
        maskId: data.ids.mask,
        padId: data.ids.pad,
        maskToken: data.maskToken,
        encode: (text)=>encodeWithData(data, text)
    };
}
const r4 = (v)=>Math.round(v * 1e4) / 1e4;
export class Agent extends HookRegistry {
    hooksRaise;
    cfg;
    provider;
    tok;
    maxLen;
    headMaxLen;
    temperatureRaw;
    temperatureByOptionsRaw;
    temperature;
    temperatureByOptions;
    constructor(opts){
        super();
        if (!opts || !opts.provider) throw new Error("Agent needs a provider");
        this.provider = opts.provider;
        this.hooks = normaliseHooks(opts.hooks, opts.onPredictStart, opts.onPredictEnd);
        this.hooksRaise = opts.hooksRaise ?? true;
        const cfg = {
            ...opts.cfg ?? {}
        };
        if (opts.max_len !== undefined) cfg.max_len = opts.max_len;
        if (opts.head_max_len !== undefined) cfg.head_max_len = opts.head_max_len;
        if (opts.temperature !== undefined) cfg.temperature = opts.temperature;
        if (opts.temperature_by_options !== undefined) cfg.temperature_by_options = opts.temperature_by_options;
        this.cfg = cfg;
        this.maxLen = Number(cfg.max_len ?? 512);
        this.headMaxLen = Number(cfg.head_max_len ?? 192);
        this.tok = opts.tok ?? defaultTokenizer();
        const raw = cfg.temperature ?? [
            1.0,
            1.0,
            1.0
        ];
        this.temperatureRaw = raw;
        const rawList = Array.isArray(raw) ? raw : [
            raw,
            raw,
            raw
        ];
        this.temperature = [
            0,
            1,
            2
        ].map((i)=>clampTemperature(rawList[i] ?? 1.0));
        this.temperatureByOptionsRaw = cfg.temperature_by_options ?? {};
        this.temperatureByOptions = Object.fromEntries(Object.entries(this.temperatureByOptionsRaw).map(([k, v])=>[
                k,
                clampTemperature(v)
            ]));
        const entries = [
            ...Object.entries(this.temperatureByOptionsRaw).map(([k, v])=>[
                    k,
                    v,
                    this.temperatureByOptions[k]
                ]),
            ...[
                0,
                1,
                2
            ].map((i)=>[
                    `temperature[${i}]`,
                    rawList[i] ?? 1.0,
                    this.temperature[i]
                ])
        ];
        const rejected = [];
        for (const [name, rawV, applied] of entries){
            if (Number(rawV) === applied) continue;
            rejected.push(`${name}=${JSON.stringify(rawV) ?? String(rawV)} -> ${applied}`);
        }
        if (rejected.length > 0) {
            console.warn(`laya: this checkpoint ships invalid temperatures or values outside [${TEMP_MIN}, ${TEMP_MAX}]; ` + `using ${rejected.join(", ")}. Treat confidence from the affected entries as uncalibrated.`);
        }
    }
    async systemOne(state, questions, opts = {}) {
        return (await this._predictHooked([
            state
        ], questions, opts))[0];
    }
    async _predictHooked(states, questions, opts) {
        const active = composeHooks(this.hooks, opts.hooks, opts.onPredictStart, opts.onPredictEnd);
        const raiseErrors = opts.hooksRaise ?? this.hooksRaise;
        const ctx = new PredictContext({
            states,
            questions: questions,
            agent: this
        });
        try {
            dispatch(active, "onPredictStart", ctx, {
                raiseErrors
            });
            if (ctx.results === null) {
                const out = [];
                for (const st of ctx.states){
                    out.push(await this._systemOneCore(st, ctx.questions));
                }
                ctx.results = out;
                ctx.model ??= out[0]?.model ?? null;
            }
        } catch (err) {
            ctx.error = err;
            try {
                dispatch(active, "onError", ctx, {
                    raiseErrors
                });
            } catch  {}
            throw err;
        } finally{
            ctx.markElapsed();
            if (ctx.results !== null) ctx.usage = aggregateUsage(ctx.results);
            try {
                dispatch(active, "onPredictEnd", ctx, {
                    raiseErrors
                });
            } catch (hookErr) {
                if (ctx.error === null) throw hookErr;
            }
        }
        return ctx.results;
    }
    async _systemOneCore(state, questions) {
        const ids = Object.keys(questions ?? {});
        if (ids.length === 0) {
            return {
                model: "laya-rl-agent",
                answers: {},
                usage: {
                    input_tokens: 0,
                    output_tokens: 0
                }
            };
        }
        const items = [];
        const internals = [];
        const stAll = this.tok.encode(serializeState(state).split(this.tok.maskToken).join(" "));
        for (const qid of ids){
            checkQuestion(qid, questions[qid]);
            const q = toInternal(questions[qid]);
            internals.push(q);
            const prefix = buildQuestionPrefix(this.tok, q, this.maxLen, this.headMaxLen);
            const { ids: seq, markers } = sequenceWithState(prefix, stAll, this.tok.sepId, this.maxLen, Array.isArray(state));
            if (markers.length !== renderOptions(q).length) {
                throw new Error(`question ${qidStr(qid)} options exceed head_max_len=${this.headMaxLen}`);
            }
            items.push({
                ids: seq,
                markers,
                qtype: QTYPES[q.t]
            });
        }
        const collated = collateItems([
            items
        ], this.tok.padId);
        if (!collated) throw new Error("no items to collate");
        const batch = collated;
        const nTokens = batch.attentionMask.flat().reduce((a, b)=>a + b, 0);
        const { lastHidden } = await this.provider.runEncoder(batch);
        const { logits, act } = await this.provider.runHead(lastHidden, batch);
        if (!Array.isArray(logits) || !Array.isArray(act) || logits.length < ids.length || act.length < ids.length) {
            throw new Error("model provider returned fewer output rows than input items");
        }
        for(let r = 0; r < ids.length; r++){
            const k = items[r].markers.length;
            if (!Array.isArray(logits[r]) || logits[r].length < k || !Array.isArray(act[r]) || act[r].length === 0 || logits[r].some((v)=>!Number.isFinite(v)) || act[r].some((v)=>!Number.isFinite(v))) {
                throw new Error(`model provider returned invalid output for question ${ids[r]}`);
            }
        }
        const answers = {};
        for(let r = 0; r < ids.length; r++){
            const qid = ids[r];
            const q = internals[r];
            const k = items[r].markers.length;
            const qt = QTYPES[q.t];
            const bucket = tempBucket(qt, k);
            const scale = this.temperatureByOptions[bucket] ?? this.temperature[qt] ?? 1.0;
            const z = logits[r].slice(0, k).map((v)=>v / scale);
            const p = softmax(z);
            const actRow = act[r] ?? [
                1,
                0
            ];
            const actP = softmax(actRow.slice(0, Math.max(2, actRow.length)));
            const ext = {
                act_probability: r4(actP[0])
            };
            if (q.t === "choice") {
                const keys = Object.keys(q.crit);
                let best = 0;
                for(let i = 1; i < p.length; i++)if (p[i] > p[best]) best = i;
                answers[qid] = {
                    type: "choice",
                    choice: keys[best],
                    probabilities: Object.fromEntries(keys.map((kk, i)=>[
                            kk,
                            r4(p[i] ?? 0)
                        ])),
                    confidence: r4(confidenceFromProbs(p)),
                    action: ext
                };
            } else if (q.t === "score") {
                const exp = p.reduce((a, v, i)=>a + i * v, 0);
                answers[qid] = {
                    type: "score",
                    score: r4(exp),
                    legend: Object.fromEntries(q.crit.map((c, i)=>[
                            String(i),
                            c
                        ])),
                    probabilities: Object.fromEntries(p.map((v, i)=>[
                            String(i),
                            r4(v)
                        ])),
                    confidence: r4(confidenceFromProbs(p)),
                    action: ext
                };
            } else {
                const pt = p[1] ?? 0;
                answers[qid] = {
                    type: "noul",
                    noul: r4(pt),
                    confidence: r4(Math.max(pt, 1 - pt)),
                    action: ext
                };
            }
        }
        return {
            model: "laya-rl-agent",
            answers,
            usage: {
                input_tokens: nTokens,
                output_tokens: 0
            }
        };
    }
    async predict(state, questions, opts = {}) {
        return this.systemOne(state, questions, opts);
    }
    static async load(modelDirOrRepo, opts) {
        const sub = opts?.subfolder ?? null;
        const isBrowser = typeof globalThis.window !== "undefined";
        let cfg = {};
        let tokenizerJson = null;
        let dir = opts?.localDir ?? modelDirOrRepo;
        let provider;
        if (isBrowser) {
            const { loadWebBundle, createWebProvider } = await import("./providers.js");
            const bundle = await loadWebBundle(modelDirOrRepo, {
                subfolder: sub
            });
            cfg = bundle.cfg;
            tokenizerJson = bundle.tokenizerJson;
            dir = bundle.dir;
            provider = await createWebProvider(dir, {
                numThreads: opts?.numThreads
            });
        } else {
            const { loadNodeBundle, createNodeProvider } = await import("./providers.js");
            const bundle = await loadNodeBundle(modelDirOrRepo, {
                subfolder: sub,
                localDir: opts?.localDir,
                token: opts?.token
            });
            cfg = bundle.cfg;
            tokenizerJson = bundle.tokenizerJson;
            dir = bundle.dir;
            provider = await createNodeProvider(dir, {
                device: opts?.device,
                numThreads: opts?.numThreads
            });
        }
        if (!tokenizerJson) {
            throw new Error(`Incompatible model: tokenizer.json is missing or invalid in ${JSON.stringify(dir)}`);
        }
        let tok;
        try {
            const parsed = tokenizerFromHF(tokenizerJson);
            if (!parsed) throw new Error("unsupported tokenizer.json format");
            tok = parsed;
        } catch (error) {
            throw new Error(`Incompatible model: tokenizer.json is missing or invalid in ${JSON.stringify(dir)}: ${String(error)}`);
        }
        return new Agent({
            provider,
            tok,
            cfg
        });
    }
}
