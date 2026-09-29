import { beforeEach, describe, expect, it, vi } from "vitest"
import { fetchCurationEvidence, uploadCurationEvidence } from "./launchpadCurationEvidence"

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

    it("uploads only for the matching signed wallet and re-reads pinned bytes before use", async () => {
        const text = "Public collection history"
        const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ cid, sha256: await sha(text) }), { status: 201 }))
            .mockResolvedValueOnce(new Response(text))
        vi.stubGlobal("fetch", fetch)
        const account = `g1${"q".repeat(38)}`
        const token = { userAddress: account, chainId: "gnoland-1", nonce: "n", expiration: "e", serverSignature: "s" } as never
        await expect(uploadCurationEvidence("C1", account, "gnoland-1", token, text)).resolves.toMatchObject({ text, cid })
        expect(fetch.mock.calls[0][0]).toContain("/api/nft/curation-evidence/upload?collection=C1")
        expect(fetch.mock.calls[0][1].headers.Authorization).toContain('"chain_id":"gnoland-1"')
        await expect(uploadCurationEvidence("C1", account, "other-chain", token, text)).rejects.toThrow("Sign in")
        expect(fetch).toHaveBeenCalledTimes(2)
    })
})
