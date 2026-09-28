/** Exact, network-bound reads for the unpublished Launchpad sales realm. */
import { isValidGnoAddressChecksum } from "./dao/address"
import { parseQevalJSON, queryEval } from "./dao/shared"
import { ACTIVE_NETWORK_KEY, currentNetworkKey, GNO_RPC_URL, isRealmValidOn } from "./config"
import { AbciQueryError } from "./rpcFallback"
import { parseLaunchpadToken, TokenLaunchpadReadError, type LaunchpadToken } from "./tokenLaunchpadClient"

export const TOKEN_LAUNCHPAD_SALES_PATH = "gno.land/r/samcrew/launchpad/sales/v1"
const MAX_INT64 = 9223372036854775807n
function invalid(message: string): never {
    throw new TokenLaunchpadReadError("invalid_response", `Launchpad sales response: ${message}`)
}

function object(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("expected an object")
    return value as Record<string, unknown>
}

function string(row: Record<string, unknown>, key: string, empty = false): string {
    const value = row[key]
    if (typeof value !== "string" || (!empty && value.length === 0)) invalid(`invalid ${key}`)
    return value as string
}

function amount(row: Record<string, unknown>, key: string): bigint {
    const value = string(row, key)
    if (value.length > 19 || !/^(0|[1-9][0-9]*)$/.test(value)) invalid(`invalid ${key}`)
    const parsed = BigInt(value)
    if (parsed > MAX_INT64) invalid(`${key} exceeds int64`)
    return parsed
}

function address(row: Record<string, unknown>, key: string, empty = false): string {
    const value = string(row, key, empty)
    if (value && !isValidGnoAddressChecksum(value)) invalid(`invalid ${key}`)
    return value
}

function bool(row: Record<string, unknown>, key: string): boolean {
    if (typeof row[key] !== "boolean") invalid(`invalid ${key}`)
    return row[key] as boolean
}

function launchId(id: string): void {
    if (!/^T[1-9][0-9]{0,9}$/.test(id)) invalid("invalid token id")
}

export interface CurveLaunchView {
    creator: string
    quoteCurrency: string
    configVersion: bigint
    status: string
    everTraded: boolean
    supply: bigint
    virtualReserve: bigint
    graduationTarget: bigint
    curveAllocation: bigint
    lpReserve: bigint
    raised: bigint
    sold: bigint
}

export interface FairSaleView {
    creator: string
    quoteCurrency: string
    configVersion: bigint
    primaryFeeBps: bigint
    treasury: string
    seedQuote: bigint
    allocation: bigint
    lotSize: bigint
    walletCapLots: bigint
    hardCapLots: bigint
    softCapQuote: bigint
    start: bigint
    end: bigint
    startPrice: bigint
    floorPrice: bigint
    decrement: bigint
    intervalSeconds: bigint
    allowlistRoot: string
    holdingGates: string
    totalLots: bigint
    totalDeposits: bigint
    hardClosedAt: bigint
    cancelled: boolean
    settled: boolean
    succeeded: boolean
    closeAt: bigint
    closePrice: bigint
    soldTokens: bigint
    grossQuote: bigint
    primaryFeeQuote: bigint
    creatorQuote: bigint
    proceedsReleased: boolean
    refundQuote: bigint
    unsoldTokens: bigint
}

export interface AirdropView { root: string; total: bigint; claimed: bigint }
export interface LaunchpadSaleView {
    token: LaunchpadToken
    tokenLiability: bigint
    vestingCount: number
    curve: CurveLaunchView | null
    fairSale: FairSaleView | null
    airdrop: AirdropView | null
}

export interface FairBuyerView {
    buyer: string
    lots: bigint
    deposit: bigint
    claimableTokens: bigint
    claimableRefund: bigint
    claimed: boolean
}

export interface VestingView {
    index: number
    beneficiary: string
    pendingBeneficiary: string
    total: bigint
    claimed: bigint
    start: bigint
    cliff: bigint
    duration: bigint
    revocable: boolean
    revoked: boolean
    revokedVested: bigint
}

function optional<T>(value: unknown, parse: (row: Record<string, unknown>) => T): T | null {
    return value === null ? null : parse(object(value))
}

export function parseLaunchpadSale(value: unknown): LaunchpadSaleView {
    const row = object(value)
    if (row.schema !== "launchpad-sales-v1") invalid("unknown schema")
    const token = parseLaunchpadToken(row.token)
    const curve = optional(row.curve, (r): CurveLaunchView => ({
        creator: address(r, "creator"), quoteCurrency: string(r, "quoteCurrency"),
        configVersion: amount(r, "configVersion"), status: string(r, "status"),
        everTraded: bool(r, "everTraded"), supply: amount(r, "supply"),
        virtualReserve: amount(r, "virtualReserve"), graduationTarget: amount(r, "graduationTarget"),
        curveAllocation: amount(r, "curveAllocation"), lpReserve: amount(r, "lpReserve"),
        raised: amount(r, "raised"), sold: amount(r, "sold"),
    }))
    const fairSale = optional(row.fairSale, (r): FairSaleView => ({
        creator: address(r, "creator"), quoteCurrency: string(r, "quoteCurrency"),
        configVersion: amount(r, "configVersion"), primaryFeeBps: amount(r, "primaryFeeBps"),
        treasury: address(r, "treasury"), seedQuote: amount(r, "seedQuote"),
        allocation: amount(r, "allocation"), lotSize: amount(r, "lotSize"),
        walletCapLots: amount(r, "walletCapLots"), hardCapLots: amount(r, "hardCapLots"),
        softCapQuote: amount(r, "softCapQuote"), start: amount(r, "start"), end: amount(r, "end"),
        startPrice: amount(r, "startPrice"), floorPrice: amount(r, "floorPrice"),
        decrement: amount(r, "decrement"), intervalSeconds: amount(r, "intervalSeconds"),
        allowlistRoot: string(r, "allowlistRoot", true), holdingGates: string(r, "holdingGates", true),
        totalLots: amount(r, "totalLots"), totalDeposits: amount(r, "totalDeposits"),
        hardClosedAt: amount(r, "hardClosedAt"), cancelled: bool(r, "cancelled"),
        settled: bool(r, "settled"), succeeded: bool(r, "succeeded"),
        closeAt: amount(r, "closeAt"), closePrice: amount(r, "closePrice"),
        soldTokens: amount(r, "soldTokens"), grossQuote: amount(r, "grossQuote"),
        primaryFeeQuote: amount(r, "primaryFeeQuote"), creatorQuote: amount(r, "creatorQuote"),
        proceedsReleased: bool(r, "proceedsReleased"), refundQuote: amount(r, "refundQuote"),
        unsoldTokens: amount(r, "unsoldTokens"),
    }))
    const airdrop = optional(row.airdrop, (r): AirdropView => ({
        root: string(r, "root"), total: amount(r, "total"), claimed: amount(r, "claimed"),
    }))
    const vestingCount = row.vestingCount
    if (!Number.isSafeInteger(vestingCount) || (vestingCount as number) < 0) invalid("invalid vestingCount")
    if (curve && (token.mode !== "curve" || curve.creator !== token.creator || curve.configVersion !== token.configVersion || !["trading", "cancelled", "graduating", "graduated", "refunding"].includes(curve.status) || curve.sold > curve.curveAllocation || curve.raised > curve.graduationTarget)) invalid("inconsistent curve")
    if (fairSale && ((token.mode !== "fairsale" && token.mode !== "direct_fixed" && token.mode !== "direct_capped") || fairSale.creator !== token.creator || (token.mode === "fairsale" && fairSale.configVersion !== token.configVersion) || fairSale.primaryFeeBps > 10000n || fairSale.seedQuote !== 0n || fairSale.soldTokens > fairSale.allocation || fairSale.primaryFeeQuote + fairSale.creatorQuote > fairSale.grossQuote)) invalid("inconsistent fair sale")
    if (fairSale?.settled && (fairSale.grossQuote + fairSale.refundQuote !== fairSale.totalDeposits || fairSale.soldTokens + fairSale.unsoldTokens !== fairSale.allocation || fairSale.primaryFeeQuote + fairSale.creatorQuote !== fairSale.grossQuote)) invalid("unbalanced settled fair sale")
    if (fairSale?.proceedsReleased && (!fairSale.settled || !fairSale.succeeded)) invalid("released unsettled proceeds")
    if (curve && fairSale) invalid("multiple sale modes")
    if (airdrop && (!/^[0-9a-f]{64}$/.test(airdrop.root) || /^0+$/.test(airdrop.root) || airdrop.claimed > airdrop.total)) invalid("inconsistent airdrop")
    return { token, tokenLiability: amount(row, "tokenLiability"), vestingCount: vestingCount as number, curve, fairSale, airdrop }
}

export function parseFairBuyer(value: unknown): FairBuyerView {
    const row = object(value)
    const result = {
        buyer: address(row, "buyer"), lots: amount(row, "lots"), deposit: amount(row, "deposit"),
        claimableTokens: amount(row, "claimableTokens"), claimableRefund: amount(row, "claimableRefund"),
        claimed: bool(row, "claimed"),
    }
    if (result.claimed && (result.claimableTokens !== 0n || result.claimableRefund !== 0n)) invalid("claimed buyer has claimable funds")
    return result
}

export function parseVesting(value: unknown): VestingView {
    const row = object(value)
    const index = row.index
    if (!Number.isSafeInteger(index) || (index as number) < 0) invalid("invalid vesting index")
    const result = {
        index: index as number, beneficiary: address(row, "beneficiary"),
        pendingBeneficiary: address(row, "pendingBeneficiary", true),
        total: amount(row, "total"), claimed: amount(row, "claimed"),
        start: amount(row, "start"), cliff: amount(row, "cliff"), duration: amount(row, "duration"),
        revocable: bool(row, "revocable"), revoked: bool(row, "revoked"),
        revokedVested: amount(row, "revokedVested"),
    }
    if (result.claimed > result.total || result.revokedVested > result.total) invalid("inconsistent vesting")
    return result
}

export class TokenLaunchpadSalesClient {
    readonly realmPath = TOKEN_LAUNCHPAD_SALES_PATH
    constructor(readonly networkKey: string = ACTIVE_NETWORK_KEY) {}

    private assertNetwork(): void {
        if (this.networkKey !== ACTIVE_NETWORK_KEY || currentNetworkKey() !== this.networkKey) {
            throw new TokenLaunchpadReadError("network_changed", "Launchpad network changed during read")
        }
        if (!isRealmValidOn(this.networkKey, this.realmPath)) {
            throw new TokenLaunchpadReadError("unavailable", "Launchpad sales realm is not enabled on this network")
        }
    }

    private async json(expression: string): Promise<unknown> {
        this.assertNetwork()
        let raw: string | null
        try {
            raw = await queryEval(GNO_RPC_URL, this.realmPath, expression, true)
        } catch (error) {
            this.assertNetwork()
            if (error instanceof AbciQueryError) throw new TokenLaunchpadReadError("realm_error", "Launchpad sales realm rejected the read", { cause: error })
            throw new TokenLaunchpadReadError("rpc_error", "Launchpad sales RPC read failed", { cause: error })
        }
        this.assertNetwork()
        if (!raw) throw new TokenLaunchpadReadError("unavailable", "Launchpad sales realm returned no data")
        const result = parseQevalJSON(raw)
        if (result === null) invalid("malformed JSON return")
        return result
    }

    async launch(id: string): Promise<LaunchpadSaleView> {
        launchId(id)
        const result = parseLaunchpadSale(await this.json(`LaunchJSON(${JSON.stringify(id)})`))
        if (result.token.id !== id) invalid("token id mismatch")
        return result
    }

    async fairBuyer(id: string, buyer: string): Promise<FairBuyerView> {
        launchId(id)
        if (!isValidGnoAddressChecksum(buyer)) invalid("invalid buyer")
        const result = parseFairBuyer(await this.json(`FairBuyerJSON(${JSON.stringify(id)}, address(${JSON.stringify(buyer)}))`))
        if (result.buyer !== buyer) invalid("buyer mismatch")
        return result
    }

    async vesting(id: string, index: number): Promise<VestingView> {
        launchId(id)
        if (!Number.isSafeInteger(index) || index < 0) invalid("invalid vesting index")
        const result = parseVesting(await this.json(`VestingJSON(${JSON.stringify(id)}, ${index})`))
        if (result.index !== index) invalid("vesting index mismatch")
        return result
    }
}
