import { beforeEach, describe, expect, it, vi } from "vitest"
import { fetchCurationEvidence } from "./launchpadCurationEvidence"

const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf6bzut6qzzmtnkzqf54j7efm5e"
const sha = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    (byte) => byte.toString(16).padStart(2, "0")).join("")

describe("public curation evidence", () => {
    beforeEach(() => vi.unstubAllGlobals())

    it("renders only text whose bytes match the on-chain digest", async () => {
        const fetch = vi.fn().mockResolvedValue(new Response("Public launch plan"))
        vi.stubGlobal("fetch", fetch)
        expect((await fetchCurationEvidence(cid, await sha("Public launch plan"))).text).toBe("Public launch plan")
        expect(fetch.mock.calls[0][0]).toBe(`https://gateway.lighthouse.storage/ipfs/${cid}`)
        expect(fetch.mock.calls[0][1].cache).toBe("no-store")
    })

    it("refuses tampered gateway bytes without showing them", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Other content")))
        await expect(fetchCurationEvidence(cid, await sha("Public launch plan"))).rejects.toThrow("do not match")
    })

    it("bounds streaming bytes and rejects arbitrary URLs", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("x".repeat(16 * 1024 + 1))))
        await expect(fetchCurationEvidence(cid, await sha("x"))).rejects.toThrow("unavailable")
        await expect(fetchCurationEvidence("https://example.com/file", "a".repeat(64))).rejects.toThrow("Invalid public evidence")
    })
})
