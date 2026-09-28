import { describe, expect, it, vi } from "vitest"
import { queryEval } from "./dao/shared"
import { parseActionTerms, readActionTerms } from "./launchpadActionTerms"
import { WUGNOT_KEY } from "./launchpadTokenTrade"

vi.mock("./dao/shared", async (original) => ({ ...(await original<typeof import("./dao/shared")>()), queryEval: vi.fn() }))

const treasury = `g1${"t".repeat(38)}`
const record = { schema: "launchpad-action-terms/v1", lane: "collection", currency: "ugnot", version: "2", treasury,
    collectionFee: "40", primaryFeeBPS: "100", currencyConfigured: true, currencyAllowed: true,
    paused: false, laneReady: true, actionReady: true }

describe("Launchpad creator action terms", () => {
    it("parses one exact policy snapshot with fee and DAO receiver", async () => {
        vi.mocked(queryEval).mockResolvedValue(`(${JSON.stringify(JSON.stringify(record))} string)`)
        await expect(readActionTerms("rpc", "collection", "ugnot")).resolves.toMatchObject({
            version: 2n, treasury, collectionFee: 40n, primaryFeeBPS: 100n, actionReady: true,
        })
        expect(queryEval).toHaveBeenCalledWith("rpc", "gno.land/r/samcrew/launchpad/config/v1",
            'ActionTermsJSON("collection", "ugnot")', true)
    })

    it("rejects changed identity, impossible gates and unsafe numeric values", () => {
        expect(() => parseActionTerms({ ...record, treasury: "bad" }, "collection", "ugnot")).toThrow("inconsistent")
        expect(() => parseActionTerms({ ...record, actionReady: false }, "collection", "ugnot")).toThrow("inconsistent")
        expect(() => parseActionTerms({ ...record, currency: WUGNOT_KEY }, "collection", "ugnot")).toThrow("identity")
        expect(parseActionTerms({ ...record, collectionFee: "9007199254740993" }, "collection", "ugnot").collectionFee).toBe(9007199254740993n)
        expect(() => parseActionTerms({ ...record, collectionFee: "9223372036854775808" }, "collection", "ugnot")).toThrow("amount")
        expect(() => parseActionTerms({ ...record, version: "02" }, "collection", "ugnot")).toThrow("amount")
        expect(() => parseActionTerms({ ...record, extra: true }, "collection", "ugnot")).toThrow("identity")
    })

    it("keeps a paused or unconfigured collection unavailable", () => {
        expect(parseActionTerms({ ...record, paused: true, actionReady: false }, "collection", "ugnot").actionReady).toBe(false)
        expect(parseActionTerms({ ...record, currencyConfigured: false, currencyAllowed: false, laneReady: false,
            collectionFee: "-1", actionReady: false }, "collection", "ugnot").actionReady).toBe(false)
    })
})
