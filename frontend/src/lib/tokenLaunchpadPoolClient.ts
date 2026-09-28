/** Network-bound, exact reads for the unpublished locked-pool realm. */
import { isValidGnoAddressChecksum } from "./dao/address"
import { parseQevalJSON, queryEval } from "./dao/shared"
import { ACTIVE_NETWORK_KEY, currentNetworkKey, GNO_RPC_URL, isRealmValidOn } from "./config"
import { AbciQueryError } from "./rpcFallback"
import { TokenLaunchpadReadError } from "./tokenLaunchpadClient"

export const TOKEN_LAUNCHPAD_POOL_PATH = "gno.land/r/samcrew/launchpad/pool/v1"
const MAX_INT64 = 9223372036854775807n
export interface LaunchpadPoolView {
    id: string
    quoteCurrency: string
    configVersion: bigint
    creator: string
    tokenReserve: bigint
    quoteReserve: bigint
}

/** Read-only ratio snapshot. configVersion is the pool's historical version,
 * not the current version required by AddLiquidity. */
export interface LaunchpadPoolAdditionQuote extends LaunchpadPoolView {
    tokenIn: bigint
    quoteIn: bigint
    newTokenReserve: bigint
    newQuoteReserve: bigint
}

function invalid(message: string): never {
    throw new TokenLaunchpadReadError("invalid_response", `Launchpad pool response: ${message}`)
}

function field(row: Record<string, unknown>, key: string): string {
    const value = row[key]
    if (typeof value !== "string" || value.length === 0) invalid(`invalid ${key}`)
    return value as string
}

function amount(row: Record<string, unknown>, key: string): bigint {
    const value = field(row, key)
    if (value.length > 19 || !/^(0|[1-9][0-9]*)$/.test(value)) invalid(`invalid ${key}`)
    const parsed = BigInt(value)
    if (parsed > MAX_INT64) invalid(`${key} exceeds int64`)
    return parsed
}

function poolFields(row: Record<string, unknown>): LaunchpadPoolView {
    const id = field(row, "id")
    const quoteCurrency = field(row, "quoteCurrency")
    const creator = field(row, "creator")
    const configVersion = amount(row, "configVersion")
    const tokenReserve = amount(row, "tokenReserve")
    const quoteReserve = amount(row, "quoteReserve")
    if (!/^T[1-9][0-9]{0,9}$/.test(id) || quoteCurrency.length > 200 ||
        !isValidGnoAddressChecksum(creator) || configVersion === 0n ||
        tokenReserve === 0n || quoteReserve === 0n) invalid("inconsistent pool")
    return { id, quoteCurrency, configVersion, creator, tokenReserve, quoteReserve }
}

function object(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("expected an object")
    return value as Record<string, unknown>
}

export function parseLaunchpadPool(value: unknown): LaunchpadPoolView {
    const row = object(value)
    if (row.schema !== "launchpad-pool-v1") invalid("unknown schema")
    return poolFields(row)
}

export function parseLaunchpadPoolAdditionQuote(value: unknown): LaunchpadPoolAdditionQuote {
    const row = object(value)
    if (row.schema !== "launchpad-pool-addition-quote-v1") invalid("unknown quote schema")
    const pool = poolFields(row)
    const tokenIn = amount(row, "tokenIn")
    const quoteIn = amount(row, "quoteIn")
    const newTokenReserve = amount(row, "newTokenReserve")
    const newQuoteReserve = amount(row, "newQuoteReserve")
    if (tokenIn === 0n || quoteIn === 0n ||
        newTokenReserve !== pool.tokenReserve + tokenIn ||
        newQuoteReserve !== pool.quoteReserve + quoteIn ||
        quoteIn !== (tokenIn * pool.quoteReserve + pool.tokenReserve - 1n) / pool.tokenReserve) {
        invalid("inconsistent addition quote")
    }
    return { ...pool, tokenIn, quoteIn, newTokenReserve, newQuoteReserve }
}

export class TokenLaunchpadPoolClient {
    readonly realmPath = TOKEN_LAUNCHPAD_POOL_PATH
    constructor(readonly networkKey: string = ACTIVE_NETWORK_KEY) {}

    private assertNetwork(): void {
        if (this.networkKey !== ACTIVE_NETWORK_KEY || currentNetworkKey() !== this.networkKey) {
            throw new TokenLaunchpadReadError("network_changed", "Launchpad network changed during pool read")
        }
        if (!isRealmValidOn(this.networkKey, this.realmPath)) {
            throw new TokenLaunchpadReadError("unavailable", "Launchpad pool realm is not enabled on this network")
        }
    }

    async pool(id: string): Promise<LaunchpadPoolView> {
        if (!/^T[1-9][0-9]{0,9}$/.test(id)) invalid("invalid token id")
        this.assertNetwork()
        let raw: string | null
        try {
            raw = await queryEval(GNO_RPC_URL, this.realmPath, `PoolJSON(${JSON.stringify(id)})`, true)
        } catch (error) {
            this.assertNetwork()
            if (error instanceof AbciQueryError) throw new TokenLaunchpadReadError("realm_error", "Launchpad pool realm rejected the read", { cause: error })
            throw new TokenLaunchpadReadError("rpc_error", "Launchpad pool RPC read failed", { cause: error })
        }
        this.assertNetwork()
        if (!raw) throw new TokenLaunchpadReadError("unavailable", "Launchpad pool realm returned no data")
        const value = parseQevalJSON(raw)
        if (value === null) invalid("malformed JSON return")
        const pool = parseLaunchpadPool(value)
        if (pool.id !== id) invalid("token id mismatch")
        return pool
    }

    async quoteAddition(id: string, tokenIn: bigint): Promise<LaunchpadPoolAdditionQuote> {
        if (!/^T[1-9][0-9]{0,9}$/.test(id) || tokenIn <= 0n || tokenIn > MAX_INT64) invalid("invalid addition request")
        this.assertNetwork()
        let raw: string | null
        try {
            raw = await queryEval(GNO_RPC_URL, this.realmPath,
                `QuoteAdditionJSON(${JSON.stringify(id)},${tokenIn.toString()})`, true)
        } catch (error) {
            this.assertNetwork()
            if (error instanceof AbciQueryError) throw new TokenLaunchpadReadError("realm_error", "Launchpad pool realm rejected the quote", { cause: error })
            throw new TokenLaunchpadReadError("rpc_error", "Launchpad pool quote RPC read failed", { cause: error })
        }
        this.assertNetwork()
        if (!raw) throw new TokenLaunchpadReadError("unavailable", "Launchpad pool realm returned no quote")
        const value = parseQevalJSON(raw)
        if (value === null) invalid("malformed JSON quote")
        const quote = parseLaunchpadPoolAdditionQuote(value)
        if (quote.id !== id || quote.tokenIn !== tokenIn) invalid("quote request mismatch")
        return quote
    }
}
