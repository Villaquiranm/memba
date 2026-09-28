/** Exact, network-bound reads of the unpublished Launchpad config gate. */
import { parseQevalJSON, queryEval } from "./dao/shared"
import { ACTIVE_NETWORK_KEY, currentNetworkKey, GNO_RPC_URL, isRealmValidOn } from "./config"
import { AbciQueryError } from "./rpcFallback"
import { TokenLaunchpadReadError } from "./tokenLaunchpadClient"

export const TOKEN_LAUNCHPAD_CONFIG_PATH = "gno.land/r/samcrew/launchpad/config/v1"
const MAX_INT64 = 9223372036854775807n
export const LAUNCHPAD_LANES = ["curve", "direct", "fairsale", "pool", "drops", "collection"] as const
export type LaunchpadLane = (typeof LAUNCHPAD_LANES)[number]

export interface LaunchpadActionStatus {
    lane: LaunchpadLane
    currency: string
    version: bigint
    paused: boolean
    allowlisted: boolean
    laneReady: boolean
    configGateOpen: boolean
}

function invalid(message: string): never {
    throw new TokenLaunchpadReadError("invalid_response", `Launchpad config response: ${message}`)
}

function lane(value: unknown): LaunchpadLane {
    if (typeof value !== "string" || !LAUNCHPAD_LANES.includes(value as LaunchpadLane)) invalid("invalid lane")
    return value as LaunchpadLane
}

function currency(value: unknown): string {
    if (typeof value !== "string" || value.length === 0 || value.length > 200) invalid("invalid currency")
    return value
}

function bool(row: Record<string, unknown>, key: string): boolean {
    if (typeof row[key] !== "boolean") invalid(`invalid ${key}`)
    return row[key] as boolean
}

export function parseLaunchpadActionStatus(value: unknown): LaunchpadActionStatus {
    if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("expected an object")
    const row = value as Record<string, unknown>
    if (row.schema !== "launchpad-config-action-v1") invalid("unknown schema")
    const version = row.version
    if (typeof version !== "string" || version.length > 19 || !/^[1-9][0-9]*$/.test(version)) invalid("invalid version")
    const parsedVersion = BigInt(version)
    if (parsedVersion > MAX_INT64) invalid("version exceeds int64")
    const paused = bool(row, "paused")
    const allowlisted = bool(row, "allowlisted")
    const laneReady = bool(row, "laneReady")
    const configGateOpen = bool(row, "configGateOpen")
    if (configGateOpen !== (!paused && allowlisted && laneReady)) invalid("inconsistent config gate")
    return {
        lane: lane(row.lane), currency: currency(row.currency), version: parsedVersion,
        paused, allowlisted, laneReady, configGateOpen,
    }
}

export class TokenLaunchpadConfigClient {
    readonly realmPath = TOKEN_LAUNCHPAD_CONFIG_PATH
    constructor(readonly networkKey: string = ACTIVE_NETWORK_KEY) {}

    private assertNetwork(): void {
        if (this.networkKey !== ACTIVE_NETWORK_KEY || currentNetworkKey() !== this.networkKey) {
            throw new TokenLaunchpadReadError("network_changed", "Launchpad network changed during config read")
        }
        if (!isRealmValidOn(this.networkKey, this.realmPath)) {
            throw new TokenLaunchpadReadError("unavailable", "Launchpad config realm is not enabled on this network")
        }
    }

    async actionStatus(actionLane: LaunchpadLane, quoteCurrency: string): Promise<LaunchpadActionStatus> {
        lane(actionLane)
        currency(quoteCurrency)
        this.assertNetwork()
        let raw: string | null
        try {
            raw = await queryEval(GNO_RPC_URL, this.realmPath,
                `ActionStatusJSON(${JSON.stringify(actionLane)},${JSON.stringify(quoteCurrency)})`, true)
        } catch (error) {
            this.assertNetwork()
            if (error instanceof AbciQueryError) throw new TokenLaunchpadReadError("realm_error", "Launchpad config realm rejected the read", { cause: error })
            throw new TokenLaunchpadReadError("rpc_error", "Launchpad config RPC read failed", { cause: error })
        }
        this.assertNetwork()
        if (!raw) throw new TokenLaunchpadReadError("unavailable", "Launchpad config realm returned no data")
        const value = parseQevalJSON(raw)
        if (value === null) invalid("malformed JSON return")
        const status = parseLaunchpadActionStatus(value)
        if (status.lane !== actionLane || status.currency !== quoteCurrency) invalid("query identity mismatch")
        return status
    }
}
