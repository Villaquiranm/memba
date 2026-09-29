/** Strict version-bound creator policy reads from the unpublished Launchpad config. */
import { parseQevalJSON, queryEval } from "./dao/shared"
import { WUGNOT_KEY } from "./launchpadTokenTrade"
import { isKnownUnclaimableLaunchpadReceiver } from "./launchpadRecipients"
import { LAUNCHPAD_CONFIG_PATH } from "./nftConfig"

const ADDRESS = /^g1[02-9ac-hj-np-z]{38}$/
const MAX_INT64 = 9223372036854775807n
export type LaunchpadActionLane = "collection" | "drops"

export interface LaunchpadActionTerms {
    lane: LaunchpadActionLane
    currency: string
    version: bigint
    treasury: string
    collectionFee: bigint
    primaryFeeBPS: bigint
    currencyConfigured: boolean
    currencyAllowed: boolean
    paused: boolean
    laneReady: boolean
    actionReady: boolean
}

function int(value: unknown, minimum: bigint): bigint {
    if (typeof value !== "string" || !/^-?(0|[1-9]\d*)$/.test(value)) throw new Error("Invalid creator policy amount")
    const number = BigInt(value)
    if (number < minimum || number > MAX_INT64) throw new Error("Invalid creator policy amount")
    return number
}

export function parseActionTerms(value: unknown, lane: LaunchpadActionLane, currency: string): LaunchpadActionTerms {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid creator policy")
    const row = value as Record<string, unknown>
    if (Object.keys(row).sort().join("|") !==
        "actionReady|collectionFee|currency|currencyAllowed|currencyConfigured|lane|laneReady|paused|primaryFeeBPS|schema|treasury|version" ||
        row.schema !== "launchpad-action-terms/v1" || row.lane !== lane || row.currency !== currency ||
        typeof row.currencyConfigured !== "boolean" || typeof row.currencyAllowed !== "boolean" ||
        typeof row.paused !== "boolean" || typeof row.laneReady !== "boolean" || typeof row.actionReady !== "boolean" ||
        typeof row.treasury !== "string") throw new Error("Creator policy identity changed")
    const version = int(row.version, 1n)
    const collectionFee = int(row.collectionFee, -1n)
    const primaryFeeBPS = int(row.primaryFeeBPS, -1n)
    const actionReady = row.actionReady as boolean
    const configured = row.currencyConfigured as boolean
    const allowed = row.currencyAllowed as boolean
    const paused = row.paused as boolean
    const laneReady = row.laneReady as boolean
    if (actionReady !== (!paused && allowed && laneReady) || (!configured && (allowed || laneReady || collectionFee !== -1n)) ||
        (actionReady && (!ADDRESS.test(row.treasury) || isKnownUnclaimableLaunchpadReceiver(row.treasury) || (lane === "collection" && collectionFee < 0n) ||
            (lane === "drops" && primaryFeeBPS < 0n))) || primaryFeeBPS > 500n) throw new Error("Creator policy is inconsistent")
    return { lane, currency, version, treasury: row.treasury, collectionFee, primaryFeeBPS,
        currencyConfigured: configured, currencyAllowed: allowed, paused, laneReady, actionReady }
}

export async function readActionTerms(rpcUrl: string, lane: LaunchpadActionLane, currency: string): Promise<LaunchpadActionTerms> {
    if ((lane !== "collection" && lane !== "drops") || (currency !== "ugnot" && currency !== WUGNOT_KEY)) {
        throw new Error("Unsupported creator policy")
    }
    const raw = await queryEval(rpcUrl, LAUNCHPAD_CONFIG_PATH,
        `ActionTermsJSON(${JSON.stringify(lane)}, ${JSON.stringify(currency)})`, true)
    if (raw === null) throw new Error("Could not verify creator policy")
    return parseActionTerms(parseQevalJSON(raw), lane, currency)
}
