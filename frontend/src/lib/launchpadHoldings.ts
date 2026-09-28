import { API_BASE_URL } from "./config"

export interface LaunchpadHolding {
    collection: string
    number: string
    owner: string
    lastEventBlock: number
}

export interface LaunchpadHoldingsPage {
    chainId: string
    indexedHeight: number
    items: LaunchpadHolding[]
    nextCursor: string
}

/** Read the new NFT ledger only. The server refuses absent or mismatched chain
 * identity, and the client validates the response before showing holdings. */
export async function fetchLaunchpadHoldings(owner: string, chainId: string, cursor = "", signal?: AbortSignal): Promise<LaunchpadHoldingsPage> {
    const query = new URLSearchParams({ owner, chain_id: chainId, limit: "20" })
    if (cursor) query.set("cursor", cursor)
    const response = await fetch(`${API_BASE_URL || ""}/api/nft/launchpad-holdings?${query}`, { signal })
    if (!response.ok) {
        if (response.status === 503) throw new Error("The holdings index is not available yet.")
        if (response.status === 409) throw new Error("The holdings index serves a different chain.")
        throw new Error("Could not load holdings.")
    }
    const raw: unknown = await response.json()
    if (!raw || typeof raw !== "object") throw new Error("Invalid holdings response.")
    const page = raw as Record<string, unknown>
    if (page.chainId !== chainId || !Number.isSafeInteger(page.indexedHeight) || (page.indexedHeight as number) < 1 ||
        !Array.isArray(page.items) || page.items.length > 20 ||
        (page.nextCursor !== undefined && (typeof page.nextCursor !== "string" || page.nextCursor.length > 128))) {
        throw new Error("Invalid holdings response.")
    }
    const items = page.items.map((item): LaunchpadHolding => {
        if (!item || typeof item !== "object") throw new Error("Invalid holding.")
        const value = item as Record<string, unknown>
        if (typeof value.collection !== "string" || !/^C[1-9]\d*$/.test(value.collection) ||
            typeof value.number !== "string" || !/^[1-9]\d*$/.test(value.number) ||
            BigInt(value.number) > 9223372036854775807n || value.owner !== owner ||
            !Number.isSafeInteger(value.lastEventBlock) || (value.lastEventBlock as number) < 1 ||
            (value.lastEventBlock as number) > (page.indexedHeight as number)) {
            throw new Error("Invalid holding.")
        }
        return value as unknown as LaunchpadHolding
    })
    return { chainId, indexedHeight: page.indexedHeight as number, items, nextCursor: (page.nextCursor as string | undefined) ?? "" }
}
