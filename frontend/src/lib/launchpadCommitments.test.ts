import { describe, expect, it } from "vitest"
import { baseURICommitment, provenanceManifestCommitment } from "./launchpadCommitments"

describe("local creator commitments", () => {
    it("hashes the exact future URI string without changing case or adding a newline", async () => {
        await expect(baseURICommitment("ipfs://a/")).resolves.toBe("7b9747382ecd72ad9efd1a9a871bf3fe8de486d54496c7b027b8add56dc3b690")
        await expect(baseURICommitment("ipfs://a")).rejects.toThrow("ending in /")
    })

    it("hashes manifest bytes locally and bounds the input size", async () => {
        const manifest = new File(["abc"], "manifest.json", { type: "application/json" })
        await expect(provenanceManifestCommitment(manifest)).resolves.toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        await expect(provenanceManifestCommitment(new File([], "empty.json"))).rejects.toThrow("nonempty")
    })
})
