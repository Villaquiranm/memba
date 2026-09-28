import { beforeEach, describe, expect, it, vi } from "vitest"
import { AbciQueryError } from "./rpcFallback"

const queryEval = vi.fn()
const currentNetworkKey = vi.fn(() => "mainnet")
const isRealmValidOn = vi.fn(() => true)
vi.mock("./dao/shared", async (load) => ({
    ...(await load<typeof import("./dao/shared")>()),
    queryEval: (...args: unknown[]) => queryEval(...args),
}))
vi.mock("./config", async (load) => ({
    ...(await load<typeof import("./config")>()),
    ACTIVE_NETWORK_KEY: "mainnet",
    GNO_RPC_URL: "https://rpc.example",
    currentNetworkKey: () => currentNetworkKey(),
    isRealmValidOn: (...args: unknown[]) => isRealmValidOn(...args),
}))

import { TokenLaunchpadSalesClient, TOKEN_LAUNCHPAD_SALES_PATH, parseLaunchpadSale, parseFairBuyer, parseVesting } from "./tokenLaunchpadSalesClient"
import { TOKEN_LAUNCHPAD_PATH } from "./tokenLaunchpadClient"

const CREATOR = "g1x7k4628w93a7wzdhqc06atzx0v50rnshweuxu0"
const BUYER = "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5"
const CFORD32 = "0123456789abcdefghjkmnpqrstvwxyz"
const BASE32 = "0123456789abcdefghijklmnopqrstuv"

function token(mode = "direct_fixed") {
    const suffix = Number(1).toString(32).padStart(7, "0").split("").map((digit) => CFORD32[BASE32.indexOf(digit)]).join("")
    return {
        id: "T1", registryKey: `${TOKEN_LAUNCHPAD_PATH}.T1`, grc20Id: `${TOKEN_LAUNCHPAD_PATH}.T1.${suffix}`,
        creator: CREATOR, mode, name: "Example", ticker: "SAME", decimals: 6,
        initialSupply: "1000", maxSupply: "1000", totalSupply: "1000", configVersion: "1",
        currencyKey: "ugnot", description: "", image: "", website: "", xHandle: "", telegram: "",
        metadataFrozen: false, mintAuthority: "", pendingMintAuthority: "", mintRenounced: false,
    }
}

function launch(mode = "direct_fixed") {
    return { schema: "launchpad-sales-v1", token: token(mode), tokenLiability: "1000", vestingCount: 0, curve: null, fairSale: null, airdrop: null }
}

function fairSale() {
    return {
        creator: CREATOR, quoteCurrency: "ugnot", configVersion: "1", primaryFeeBps: "250", treasury: BUYER,
        seedQuote: "0", allocation: "1000", lotSize: "10", walletCapLots: "50", hardCapLots: "100",
        softCapQuote: "300", start: "100", end: "200", startPrice: "12", floorPrice: "8",
        decrement: "1", intervalSeconds: "10", allowlistRoot: "", holdingGates: "",
        totalLots: "75", totalDeposits: "900", hardClosedAt: "0", cancelled: false,
        settled: true, succeeded: true, closeAt: "200", closePrice: "8", soldTokens: "750",
        grossQuote: "600", primaryFeeQuote: "15", creatorQuote: "585", proceedsReleased: true,
        refundQuote: "300", unsoldTokens: "250",
    }
}

function curve() {
    return {
        creator: CREATOR, quoteCurrency: "ugnot", configVersion: "1", status: "trading", everTraded: false,
        supply: "1000", virtualReserve: "100", graduationTarget: "600", curveAllocation: "800",
        lpReserve: "200", raised: "0", sold: "0",
    }
}

function qjson(value: unknown): string { return `(${JSON.stringify(JSON.stringify(value))} string)` }

beforeEach(() => {
    queryEval.mockReset()
    currentNetworkKey.mockReturnValue("mainnet")
    isRealmValidOn.mockReset()
    isRealmValidOn.mockReturnValue(true)
})

describe("Token Launchpad sales reader", () => {
    it("parses direct, fair, curve and airdrop state with exact int64 amounts", () => {
        expect(parseLaunchpadSale(launch()).fairSale).toBeNull()
        const fair = parseLaunchpadSale({ ...launch("fairsale"), fairSale: fairSale(), airdrop: { root: "a".repeat(64), total: "9223372036854775807", claimed: "1" } })
        expect(fair.fairSale?.creatorQuote).toBe(585n)
        expect(fair.airdrop?.total).toBe(9223372036854775807n)
        for (const mode of ["direct_fixed", "direct_capped"]) {
            const attached = parseLaunchpadSale({ ...launch(mode), fairSale: { ...fairSale(), configVersion: "2" } })
            expect(attached.fairSale?.configVersion).toBe(2n)
        }
        const curved = parseLaunchpadSale({ ...launch("curve"), curve: curve() })
        expect(curved.curve?.graduationTarget).toBe(600n)
    })

    it("rejects malformed or contradictory sale records", () => {
        for (const value of [
            { ...launch(), schema: "v2" },
            { ...launch(), tokenLiability: 1 },
            { ...launch(), tokenLiability: "01" },
            { ...launch(), tokenLiability: "9".repeat(100000) },
            { ...launch(), vestingCount: "0" },
            { ...launch("curve"), curve: { ...curve(), sold: "801" } },
            { ...launch("curve"), curve: { ...curve(), creator: BUYER } },
            { ...launch("fairsale"), fairSale: { ...fairSale(), seedQuote: "1" } },
            { ...launch("fairsale"), fairSale: { ...fairSale(), primaryFeeQuote: "601" } },
            { ...launch("fairsale"), fairSale: { ...fairSale(), creatorQuote: "584" } },
            { ...launch("curve"), curve: { ...curve(), status: "unknown" } },
            { ...launch(), airdrop: { root: "x", total: "1", claimed: "2" } },
        ]) expect(() => parseLaunchpadSale(value)).toThrow()
    })

    it("parses buyer claims and vesting schedules, refusing inconsistent balances", () => {
        const buyer = { buyer: BUYER, lots: "2", deposit: "24", claimableTokens: "20", claimableRefund: "8", claimed: false }
        expect(parseFairBuyer(buyer).claimableRefund).toBe(8n)
        expect(() => parseFairBuyer({ ...buyer, claimed: true })).toThrow()
        expect(() => parseFairBuyer({ ...buyer, deposit: "9".repeat(100000) })).toThrow()
        const vesting = {
            index: 0, beneficiary: CREATOR, pendingBeneficiary: "", total: "100", claimed: "25",
            start: "100", cliff: "10", duration: "200", revocable: true, revoked: false, revokedVested: "0",
        }
        expect(parseVesting(vesting).claimed).toBe(25n)
        expect(() => parseVesting({ ...vesting, claimed: "101" })).toThrow()
        expect(() => parseVesting({ ...vesting, total: "9".repeat(100000) })).toThrow()
    })

    it("uses exact source expressions and checks returned token, buyer and vesting identities", async () => {
        queryEval.mockResolvedValueOnce(qjson(launch()))
            .mockResolvedValueOnce(qjson({ buyer: BUYER, lots: "0", deposit: "0", claimableTokens: "0", claimableRefund: "0", claimed: false }))
            .mockResolvedValueOnce(qjson({ index: 0, beneficiary: CREATOR, pendingBeneficiary: "", total: "100", claimed: "0", start: "0", cliff: "0", duration: "100", revocable: false, revoked: false, revokedVested: "0" }))
        const reader = new TokenLaunchpadSalesClient()
        expect((await reader.launch("T1")).token.id).toBe("T1")
        expect((await reader.fairBuyer("T1", BUYER)).buyer).toBe(BUYER)
        expect((await reader.vesting("T1", 0)).total).toBe(100n)
        expect(queryEval.mock.calls.map((call) => call.slice(1, 3))).toEqual([
            [TOKEN_LAUNCHPAD_SALES_PATH, 'LaunchJSON("T1")'],
            [TOKEN_LAUNCHPAD_SALES_PATH, `FairBuyerJSON("T1", address("${BUYER}"))`],
            [TOKEN_LAUNCHPAD_SALES_PATH, 'VestingJSON("T1", 0)'],
        ])
        expect(queryEval.mock.calls.every((call) => call[3] === true)).toBe(true)
        await expect(reader.launch('T1");panic(1)//')).rejects.toMatchObject({ code: "invalid_response" })
        await expect(reader.vesting("T1", -1)).rejects.toMatchObject({ code: "invalid_response" })
        expect(queryEval).toHaveBeenCalledTimes(3)
    })

    it("rejects identities swapped by a realm response", async () => {
        const reader = new TokenLaunchpadSalesClient()
        queryEval.mockResolvedValueOnce(qjson({ ...launch(), token: { ...token(), id: "T2" } }))
        await expect(reader.launch("T1")).rejects.toMatchObject({ code: "invalid_response" })
        queryEval.mockResolvedValueOnce(qjson({ buyer: CREATOR, lots: "0", deposit: "0", claimableTokens: "0", claimableRefund: "0", claimed: false }))
        await expect(reader.fairBuyer("T1", BUYER)).rejects.toMatchObject({ code: "invalid_response" })
        queryEval.mockResolvedValueOnce(qjson({ index: 1, beneficiary: CREATOR, pendingBeneficiary: "", total: "1", claimed: "0", start: "0", cliff: "0", duration: "1", revocable: false, revoked: false, revokedVested: "0" }))
        await expect(reader.vesting("T1", 0)).rejects.toMatchObject({ code: "invalid_response" })
    })

    it("keeps unavailable and changed networks separate from RPC and realm failures", async () => {
        const reader = new TokenLaunchpadSalesClient()
        isRealmValidOn.mockReturnValueOnce(false)
        await expect(reader.launch("T1")).rejects.toMatchObject({ code: "unavailable" })
        queryEval.mockResolvedValueOnce(null)
        await expect(reader.launch("T1")).rejects.toMatchObject({ code: "unavailable" })
        queryEval.mockRejectedValueOnce(new AbciQueryError("vm/qeval", "missing"))
        await expect(reader.launch("T1")).rejects.toMatchObject({ code: "realm_error" })
        queryEval.mockRejectedValueOnce(new Error("offline"))
        await expect(reader.launch("T1")).rejects.toMatchObject({ code: "rpc_error" })
        queryEval.mockImplementationOnce(async () => { currentNetworkKey.mockReturnValue("testnet"); return qjson(launch()) })
        await expect(reader.launch("T1")).rejects.toMatchObject({ code: "network_changed" })
    })

    it("keeps the unpublished sales realm out of the real mainnet allowlist", async () => {
        const config = await vi.importActual<typeof import("./config")>("./config")
        expect(config.isRealmValidOn("mainnet", TOKEN_LAUNCHPAD_SALES_PATH)).toBe(false)
    })
})
