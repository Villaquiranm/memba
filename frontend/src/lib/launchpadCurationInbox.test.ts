import { beforeEach, describe, expect, it, vi } from "vitest"
import { readCurationAccess, readCurationThread, sendCurationMessage } from "./launchpadCurationInbox"

const account = `g1${"q".repeat(38)}`
const founder = `g1${"p".repeat(38)}`
const token = { nonce: "n", expiration: "e", userAddress: account, serverSignature: "s", chainId: "gnoland-1" } as never
const access = { collection: "C1", account, founder, revision: "1", status: "submitted",
    isFounder: false, isManager: true, canRead: true, canReview: true }
const message = { id: "a".repeat(32), sender: account, revision: 1, createdAt: 1700000000000000, text: "Hello founder" }

describe("private curation inbox client", () => {
    beforeEach(() => { vi.unstubAllGlobals() })

    it("binds requests to the signed account and network", async () => {
        const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => access })
        vi.stubGlobal("fetch", fetch)
        await expect(readCurationAccess("C1", account, "gnoland-1", token)).resolves.toMatchObject({ canRead: true })
        expect(fetch.mock.calls[0][1].headers.Authorization).toContain('"chain_id":"gnoland-1"')
        expect(fetch.mock.calls[0][1].cache).toBe("no-store")
        await expect(readCurationAccess("C1", founder, "gnoland-1", token)).rejects.toThrow("Sign in")
        await expect(readCurationAccess("C1", account, "other-chain", token)).rejects.toThrow("Sign in")
        expect(fetch).toHaveBeenCalledTimes(1)
    })

    it("rejects inconsistent permission and cross-chain thread responses", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ ...access, canRead: false }) })
            .mockResolvedValueOnce({ ok: true, json: async () => ({ chainId: "other-chain", collection: "C1", messages: [message] }) }))
        await expect(readCurationAccess("C1", account, "gnoland-1", token)).rejects.toThrow("Invalid curation access")
        await expect(readCurationThread("C1", account, "gnoland-1", token)).rejects.toThrow("Invalid discussion")
    })

    it("sends an idempotent text message and verifies the sender and content", async () => {
        const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => message })
        vi.stubGlobal("fetch", fetch)
        await expect(sendCurationMessage("C1", account, "gnoland-1", token, "b".repeat(32), " Hello founder ")).resolves.toEqual(message)
        expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ clientId: "b".repeat(32), text: "Hello founder" })
        await expect(sendCurationMessage("C1", account, "gnoland-1", token, "b".repeat(32), "é".repeat(2001))).rejects.toThrow("4,000 bytes")
        expect(fetch).toHaveBeenCalledTimes(1)
    })
})
