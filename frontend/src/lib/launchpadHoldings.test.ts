import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchLaunchpadHoldings } from "./launchpadHoldings"

const owner = "g1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

afterEach(() => vi.unstubAllGlobals())

describe("Launchpad holdings API", () => {
    it("scopes the request to wallet and chain, retaining large token numbers as strings", async () => {
        const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
            chainId: "gnoland-1", indexedHeight: 42,
            items: [{ collection: "C1", number: "9007199254740993", owner, lastEventBlock: 40 }],
            nextCursor: "QzE6OTAwNzE5OTI1NDc0MDk5Mw",
        }) })
        vi.stubGlobal("fetch", fetcher)
        const page = await fetchLaunchpadHoldings(owner, "gnoland-1")
        expect(page.items[0].number).toBe("9007199254740993")
        expect(String(fetcher.mock.calls[0][0])).toContain(`owner=${owner}`)
        expect(String(fetcher.mock.calls[0][0])).toContain("chain_id=gnoland-1")
    })

    it("rejects mixed-chain, misowned and unready responses", async () => {
        const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
            chainId: "pearl-1", indexedHeight: 42, items: [],
        }) })
        vi.stubGlobal("fetch", fetcher)
        await expect(fetchLaunchpadHoldings(owner, "gnoland-1")).rejects.toThrow("Invalid holdings response")
        fetcher.mockResolvedValue({ ok: true, json: async () => ({
            chainId: "gnoland-1", indexedHeight: 42,
            items: [{ collection: "C1", number: "1", owner: "g1someoneelse", lastEventBlock: 40 }],
        }) })
        await expect(fetchLaunchpadHoldings(owner, "gnoland-1")).rejects.toThrow("Invalid holding")
        fetcher.mockResolvedValue({ ok: false, status: 503 })
        await expect(fetchLaunchpadHoldings(owner, "gnoland-1")).rejects.toThrow("not available yet")
    })
})
