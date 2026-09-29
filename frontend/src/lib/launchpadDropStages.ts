/** Strict reads and reviewed creator scheduling for fixed-price primary drops. */
import { parseQevalJSON, queryEval } from "./dao/shared"
import { clearGovernanceReceipt, type GovernanceScope } from "./dao/governanceRecovery"
import { doContractBroadcast, type AminoMsg } from "./grc20"
import { readActionTerms, type LaunchpadActionTerms } from "./launchpadActionTerms"
import { formatGnotPrice, parseGnotPrice } from "./launchpadListing"
import { getLaunchpadNftCollection, type LaunchpadNftCollection } from "./launchpadNft"
import { LAUNCHPAD_DROPS_PATH } from "./nftConfig"
import type { SignRequest } from "../os/sign/signer"

const MAX_INT64 = 9223372036854775807n
const MAX_REVIEWABLE_TIME = 253402300799n
export const ADD_FIXED_STAGE_GAS_WANTED = 50_000_000
const STORAGE_CAP = 5_000_000
const YEAR_SECONDS = 365n * 24n * 60n * 60n

export interface FixedDropStage {
    collection: string
    index: number
    start: bigint
    end: bigint
    price: bigint
    currency: string
    supplyCap: bigint
    perWallet: bigint
    minted: bigint
}

export interface FixedDropStageDraft {
    collection: string
    creator: string
    start: bigint
    end: bigint
    price: bigint
    supplyCap: bigint
    perWallet: bigint
}

function decimal(value: unknown): bigint {
    if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw new Error("Invalid drop stage amount")
    const number = BigInt(value)
    if (number > MAX_INT64) throw new Error("Drop stage amount exceeds contract range")
    return number
}

export function parseFixedDropStages(value: unknown, collection: string): FixedDropStage[] {
    if (!/^C[1-9]\d*$/.test(collection) || !Array.isArray(value) || value.length > 10) throw new Error("Invalid drop stage list")
    const stages = value.map((entry, index): FixedDropStage => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid drop stage")
        const row = entry as Record<string, unknown>
        if (Object.keys(row).sort().join("|") !== "collection|currency|end|index|kind|minted|perWallet|price|start|supplyCap" ||
            row.collection !== collection || row.kind !== "fixed" || row.index !== index || typeof row.currency !== "string" ||
            row.currency.length === 0) throw new Error("Drop stage identity changed")
        const stage = { collection, index, start: decimal(row.start), end: decimal(row.end), price: decimal(row.price),
            currency: row.currency, supplyCap: decimal(row.supplyCap), perWallet: decimal(row.perWallet), minted: decimal(row.minted) }
        if (stage.end <= stage.start || stage.end - stage.start > YEAR_SECONDS || stage.perWallet < 1n ||
            stage.perWallet > 1_000_000n || (stage.supplyCap > 0n && (stage.perWallet > stage.supplyCap || stage.minted > stage.supplyCap))) {
            throw new Error("Inconsistent drop stage")
        }
        return stage
    })
    for (let index = 0; index < stages.length; index++) for (let prior = 0; prior < index; prior++) {
        if (stages[index].start < stages[prior].end && stages[prior].start < stages[index].end) throw new Error("Overlapping drop stages")
    }
    return stages
}

export async function readFixedDropStages(rpcUrl: string, collection: string): Promise<FixedDropStage[]> {
    if (!/^C[1-9]\d*$/.test(collection)) throw new Error("Invalid collection ID")
    const raw = await queryEval(rpcUrl, LAUNCHPAD_DROPS_PATH, `ListStagesJSON(${JSON.stringify(collection)})`, true)
    if (raw === null) throw new Error("Could not verify drop stages")
    return parseFixedDropStages(parseQevalJSON(raw), collection)
}

export function validateFixedDropStage(draft: FixedDropStageDraft, terms: LaunchpadActionTerms,
    stages: FixedDropStage[], now = BigInt(Math.floor(Date.now() / 1000)), collection?: LaunchpadNftCollection): void {
    if (!/^C[1-9]\d*$/.test(draft.collection) || !/^g1[02-9ac-hj-np-z]{38}$/.test(draft.creator) ||
        terms.lane !== "drops" || terms.currency !== "ugnot" || !terms.actionReady || terms.primaryFeeBPS < 0n ||
        terms.primaryFeeBPS > 500n || terms.version < 1n || !/^g1[02-9ac-hj-np-z]{38}$/.test(terms.treasury)) {
        throw new Error("Primary drops are unavailable under the current DAO policy.")
    }
    if (stages.length >= 10 || draft.start < now || draft.end > MAX_REVIEWABLE_TIME ||
        draft.end <= draft.start || draft.end - draft.start > YEAR_SECONDS ||
        draft.price < 0n || draft.price > MAX_INT64 || draft.supplyCap < 0n || draft.supplyCap > MAX_INT64 ||
        draft.perWallet < 1n || draft.perWallet > 1_000_000n ||
        (draft.supplyCap > 0n && draft.perWallet > draft.supplyCap) ||
        stages.some((stage) => draft.start < stage.end && stage.start < draft.end)) {
        throw new Error("Check stage dates, price, supply, wallet limit and overlap.")
    }
    if (collection && (collection.id !== draft.collection || collection.creator !== draft.creator ||
        (collection.maxSupply > 0n && draft.supplyCap > 0n &&
            draft.supplyCap > collection.maxSupply - collection.minted))) {
        throw new Error("Stage exceeds the collection's remaining supply or creator authority.")
    }
}

export function addFixedDropStageScope(chainId: string, draft: FixedDropStageDraft): GovernanceScope {
    return { chainId, realmPath: LAUNCHPAD_DROPS_PATH, caller: draft.creator, operation: `add-fixed-stage:${draft.collection}` }
}

export function buildAddFixedDropStageMsg(draft: FixedDropStageDraft, terms: LaunchpadActionTerms,
    stages: FixedDropStage[], now?: bigint): AminoMsg {
    validateFixedDropStage(draft, terms, stages, now)
    return { type: "vm/MsgCall", value: { caller: draft.creator, send: "", pkg_path: LAUNCHPAD_DROPS_PATH,
        func: "AddFixedStage", args: [draft.collection, draft.start.toString(), draft.end.toString(), draft.price.toString(),
            draft.supplyCap.toString(), draft.perWallet.toString(), "ugnot", terms.version.toString()],
        max_deposit: `${STORAGE_CAP}ugnot` } }
}

function sameTerms(a: LaunchpadActionTerms, b: LaunchpadActionTerms): boolean {
    return a.lane === b.lane && a.currency === b.currency && a.version === b.version && a.treasury === b.treasury &&
        a.primaryFeeBPS === b.primaryFeeBPS && a.collectionFee === b.collectionFee &&
        a.currencyConfigured === b.currencyConfigured && a.currencyAllowed === b.currencyAllowed &&
        a.paused === b.paused && a.laneReady === b.laneReady && a.actionReady === b.actionReady
}

function sameStage(a: FixedDropStage, b: FixedDropStage): boolean {
    return a.collection === b.collection && a.index === b.index && a.start === b.start && a.end === b.end &&
        a.price === b.price && a.currency === b.currency && a.supplyCap === b.supplyCap &&
        a.perWallet === b.perWallet && a.minted === b.minted
}

function utc(seconds: bigint): string {
    const date = new Date(Number(seconds) * 1000)
    return Number.isFinite(date.valueOf()) ? date.toISOString() : `${seconds.toString()} Unix seconds`
}

export function addFixedDropStageRequest(input: { draft: FixedDropStageDraft; terms: LaunchpadActionTerms;
    collection: LaunchpadNftCollection; stages: FixedDropStage[]; rpcUrl: string; chainId: string;
    estimatedGasFeeUgnot: number; onSettled?: () => void }): SignRequest {
    const { draft, terms, rpcUrl, chainId, estimatedGasFeeUgnot } = input
    if (!Number.isSafeInteger(estimatedGasFeeUgnot) || estimatedGasFeeUgnot <= 0) throw new Error("Could not estimate the network fee.")
    validateFixedDropStage(draft, terms, input.stages, undefined, input.collection)
    const msg = buildAddFixedDropStageMsg(draft, terms, input.stages)
    const scope = addFixedDropStageScope(chainId, draft)
    const plannedIndex = input.stages.length
    return {
        title: "Schedule fixed-price NFT drop", summary: `${draft.collection} · ${formatGnotPrice(draft.price)} per mint`,
        lines: () => [["Collection", draft.collection], ["Creator", draft.creator],
            ["Starts", new Date(Number(draft.start) * 1000).toISOString()],
            ["Ends", new Date(Number(draft.end) * 1000).toISOString()],
            ["Mint price", draft.price === 0n ? "Free" : formatGnotPrice(draft.price)],
            ["Stage supply cap", draft.supplyCap === 0n ? "Collection cap only" : draft.supplyCap.toLocaleString()],
            ["Per wallet", draft.perWallet.toLocaleString()],
            ["DAO primary fee", `${terms.primaryFeeBPS.toString()} bps from the mint price`],
            ["DAO treasury", terms.treasury], ["Policy version", terms.version.toString()],
            ["Expected stage index", plannedIndex.toString()], ["Realm", LAUNCHPAD_DROPS_PATH], ["Network", chainId],
            ["Gas limit", ADD_FIXED_STAGE_GAS_WANTED.toLocaleString()],
            ["Estimated gas fee", `${estimatedGasFeeUgnot.toLocaleString()} ugnot`],
            ["Storage deposit cap", `${STORAGE_CAP.toLocaleString()} ugnot`]],
        warns: ["Stages cannot overlap. This stage can be edited only before its original start; after it starts, its price and limits are fixed.",
            "Each mint credits the creator and DAO atomically. Soulbound recipients claim for themselves; hidden-reveal collections cannot mint until revealed."],
        acks: ["I checked the collection, UTC start and end, mint price, wallet and supply limits, DAO fee and network."],
        label: () => `Schedule ${draft.collection} drop`, receipt: scope, prepare: () => ({ msgs: [msg] }),
        recheck: async () => {
            const [fresh, collection, stages] = await Promise.all([
                readActionTerms(rpcUrl, "drops", "ugnot"), getLaunchpadNftCollection(rpcUrl, draft.collection),
                readFixedDropStages(rpcUrl, draft.collection),
            ])
            if (!sameTerms(terms, fresh) || stages.length !== plannedIndex ||
                stages.some((stage, index) => !sameStage(stage, input.stages[index]))) {
                throw new Error("Drop stage or DAO policy changed. Refresh before signing.")
            }
            validateFixedDropStage(draft, fresh, stages, undefined, collection)
            buildAddFixedDropStageMsg(draft, fresh, stages)
        },
        send: (_choice, beforeSign) => doContractBroadcast([msg], `Schedule ${draft.collection} drop`,
            { gasWanted: ADD_FIXED_STAGE_GAS_WANTED, retry: false, beforeSign }),
        verify: async () => {
            const stages = await readFixedDropStages(rpcUrl, draft.collection)
            const created = stages[plannedIndex]
            return stages.length === plannedIndex + 1 && created.start === draft.start && created.end === draft.end &&
                created.price === draft.price && created.supplyCap === draft.supplyCap && created.perWallet === draft.perWallet &&
                created.currency === "ugnot" && created.minted === 0n
        },
        onSettled: (outcome) => {
            if (outcome === "confirmed") { try { clearGovernanceReceipt(scope) } catch { /* retain conservative lock */ } }
            input.onSettled?.()
        },
    }
}

export function parseFreeOrGnotPrice(text: string): bigint { return text === "0" ? 0n : parseGnotPrice(text) }

export function editFixedStageScope(chainId: string, draft: FixedDropStageDraft, index: number): GovernanceScope {
    return { chainId, realmPath: LAUNCHPAD_DROPS_PATH, caller: draft.creator,
        operation: `edit-fixed-stage:${draft.collection}:${index}` }
}

export function buildEditFixedStageMsg(draft: FixedDropStageDraft, index: number, terms: LaunchpadActionTerms,
    collection: LaunchpadNftCollection, stages: FixedDropStage[], now = BigInt(Math.floor(Date.now() / 1000))): AminoMsg {
    if (!Number.isSafeInteger(index) || index < 0 || index >= stages.length || stages[index].start <= now ||
        stages[index].minted !== 0n) throw new Error("Only a stage before its original start can be edited.")
    validateFixedDropStage(draft, terms, stages.filter((stage) => stage.index !== index), now, collection)
    return { type: "vm/MsgCall", value: { caller: draft.creator, send: "", pkg_path: LAUNCHPAD_DROPS_PATH,
        func: "EditFixedStage", args: [draft.collection, index.toString(), draft.start.toString(), draft.end.toString(),
            draft.price.toString(), draft.supplyCap.toString(), draft.perWallet.toString(), "ugnot", terms.version.toString()],
        max_deposit: `${STORAGE_CAP}ugnot` } }
}

export function editFixedStageRequest(input: { draft: FixedDropStageDraft; index: number; terms: LaunchpadActionTerms;
    collection: LaunchpadNftCollection; stages: FixedDropStage[]; rpcUrl: string; chainId: string;
    estimatedGasFeeUgnot: number; onSettled?: () => void }): SignRequest {
    const { draft, index, terms, collection, stages, rpcUrl, chainId, estimatedGasFeeUgnot } = input
    if (!Number.isSafeInteger(estimatedGasFeeUgnot) || estimatedGasFeeUgnot <= 0) throw new Error("Could not estimate the network fee.")
    const original = stages[index]
    const msg = buildEditFixedStageMsg(draft, index, terms, collection, stages)
    const scope = editFixedStageScope(chainId, draft, index)
    return {
        title: "Edit scheduled NFT drop", summary: `${draft.collection} · stage ${index + 1}`,
        lines: () => [["Collection", draft.collection], ["Creator", draft.creator], ["Stage", (index + 1).toString()],
            ["Original start", utc(original.start)],
            ["Original price", original.price === 0n ? "Free" : formatGnotPrice(original.price)],
            ["New start", utc(draft.start)],
            ["New end", utc(draft.end)],
            ["New mint price", draft.price === 0n ? "Free" : formatGnotPrice(draft.price)],
            ["New stage cap", draft.supplyCap === 0n ? "Collection cap only" : draft.supplyCap.toLocaleString()],
            ["New per-wallet limit", draft.perWallet.toLocaleString()],
            ["DAO primary fee", `${terms.primaryFeeBPS.toString()} bps from each mint price`],
            ["DAO treasury", terms.treasury], ["Policy version", terms.version.toString()],
            ["Realm", LAUNCHPAD_DROPS_PATH], ["Network", chainId], ["Gas limit", ADD_FIXED_STAGE_GAS_WANTED.toLocaleString()],
            ["Estimated gas fee", `${estimatedGasFeeUgnot.toLocaleString()} ugnot`],
            ["Storage deposit cap", `${STORAGE_CAP.toLocaleString()} ugnot`]],
        warns: ["This edit is permitted only before the original stage start. Once it begins, price, dates and limits cannot be changed.",
            "Collectors should be notified of changes to a published drop schedule."],
        acks: ["I checked the original stage and the new UTC schedule, price, limits, DAO fee and network."],
        label: () => `Edit ${draft.collection} stage ${index + 1}`, receipt: scope, prepare: () => ({ msgs: [msg] }),
        recheck: async () => {
            const [freshTerms, freshCollection, freshStages] = await Promise.all([
                readActionTerms(rpcUrl, "drops", "ugnot"), getLaunchpadNftCollection(rpcUrl, draft.collection),
                readFixedDropStages(rpcUrl, draft.collection),
            ])
            if (!sameTerms(terms, freshTerms) || freshCollection.creator !== collection.creator ||
                freshStages.length !== stages.length || freshStages.some((stage, offset) => !sameStage(stage, stages[offset]))) {
                throw new Error("Drop stage or DAO policy changed. Refresh before signing.")
            }
            buildEditFixedStageMsg(draft, index, freshTerms, freshCollection, freshStages)
        },
        send: (_choice, beforeSign) => doContractBroadcast([msg], `Edit ${draft.collection} stage ${index + 1}`,
            { gasWanted: ADD_FIXED_STAGE_GAS_WANTED, retry: false, beforeSign }),
        verify: async () => {
            const fresh = await readFixedDropStages(rpcUrl, draft.collection)
            if (fresh.length !== stages.length || fresh.some((stage, offset) => offset !== index && !sameStage(stage, stages[offset]))) return false
            const edited = fresh[index]
            return edited.start === draft.start && edited.end === draft.end && edited.price === draft.price &&
                edited.supplyCap === draft.supplyCap && edited.perWallet === draft.perWallet && edited.currency === "ugnot" &&
                edited.minted === 0n
        },
        onSettled: (outcome) => {
            if (outcome === "confirmed") { try { clearGovernanceReceipt(scope) } catch { /* retain conservative lock */ } }
            input.onSettled?.()
        },
    }
}
