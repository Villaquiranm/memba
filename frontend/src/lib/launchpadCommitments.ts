/** Local SHA-256 helpers. No file or future URI is uploaded by these functions. */
import { validateBaseURI } from "./launchpadCollectionCreate"

function hex(bytes: ArrayBuffer): string {
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function hash(bytes: BufferSource): Promise<string> {
    if (!globalThis.crypto?.subtle) throw new Error("Secure SHA-256 hashing is unavailable in this browser.")
    return hex(await globalThis.crypto.subtle.digest("SHA-256", bytes))
}

export async function baseURICommitment(baseURI: string): Promise<string> {
    validateBaseURI(baseURI)
    return hash(new TextEncoder().encode(baseURI))
}

export async function provenanceManifestCommitment(file: File): Promise<string> {
    if (file.size < 1 || file.size > 10_000_000) throw new Error("Choose a nonempty manifest file under 10 MB.")
    return hash(await file.arrayBuffer())
}
