import type { Token } from "../gen/memba/v1/memba_pb"
import { API_BASE_URL } from "./config"
import { walletBearer } from "./walletBearer"

export interface CurationAccess {
    collection: string
    account: string
    founder: string
    revision: string
    status: "submitted" | "changes_requested" | "recommended" | "declined"
    isFounder: boolean
    isManager: boolean
    canRead: boolean
    canReview: boolean
}

export interface CurationMessage {
    id: string
    sender: string
    revision: number
    createdAt: number
    text: string
}

export interface CurationThreadPage {
    chainId: string
    collection: string
    messages: CurationMessage[]
    nextCursor: string
}

const collectionPattern = /^C[1-9][0-9]{0,17}$/
const messageIDPattern = /^[0-9a-f]{32}$/
const addressPattern = /^g1[02-9ac-hj-np-z]{38}$/

export class CurationInboxError extends Error {
    constructor(readonly status: number) { super(status === 401 ? "Sign in again to open this discussion." :
        status === 403 || status === 404 ? "This wallet cannot open this founder discussion." :
        status === 429 ? "Message limit reached. Wait a minute and try again." :
        status === 503 ? "The private discussion is unavailable. Try again later." :
        "Could not load the private discussion.") }
}

function auth(token: Token, account: string, chainId: string): HeadersInit {
    if (!account || token.userAddress !== account || token.chainId !== chainId) throw new Error("Sign in with the wallet on this network to open the discussion.")
    return { Authorization: walletBearer(token) }
}

function endpoint(collection: string, route: string): string {
    if (!collectionPattern.test(collection)) throw new Error("Invalid collection ID.")
    return `${API_BASE_URL || ""}/api/nft/${route}?${new URLSearchParams({ collection })}`
}

async function readResponse(response: Response): Promise<unknown> {
    if (!response.ok) throw new CurationInboxError(response.status)
    return response.json()
}

export async function readCurationAccess(collection: string, account: string, chainId: string, token: Token, signal?: AbortSignal): Promise<CurationAccess> {
    const raw = await readResponse(await fetch(endpoint(collection, "curation-access"), {
        headers: auth(token, account, chainId), cache: "no-store", signal,
    }))
    if (!raw || typeof raw !== "object") throw new Error("Invalid curation access response.")
    const value = raw as Record<string, unknown>
    if (value.collection !== collection || value.account !== account || typeof value.founder !== "string" ||
        !addressPattern.test(value.founder) || typeof value.revision !== "string" || !/^[1-9]\d*$/.test(value.revision) ||
        !["submitted", "changes_requested", "recommended", "declined"].includes(String(value.status)) ||
        typeof value.isFounder !== "boolean" || typeof value.isManager !== "boolean" ||
        typeof value.canRead !== "boolean" || typeof value.canReview !== "boolean" ||
        value.isFounder !== (value.founder === account) || (value.isFounder && value.isManager) ||
        value.canRead !== (value.isFounder || value.isManager) ||
        value.canReview !== (value.isManager && (value.status === "submitted" || value.status === "changes_requested"))) {
        throw new Error("Invalid curation access response.")
    }
    return value as unknown as CurationAccess
}

function validMessage(raw: unknown): CurationMessage {
    if (!raw || typeof raw !== "object") throw new Error("Invalid discussion response.")
    const value = raw as Record<string, unknown>
    if (typeof value.id !== "string" || !messageIDPattern.test(value.id) ||
        typeof value.sender !== "string" || !addressPattern.test(value.sender) ||
        !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 ||
        !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 1 ||
        !Number.isFinite(new Date((value.createdAt as number) / 1000).valueOf()) ||
        typeof value.text !== "string" || new TextEncoder().encode(value.text).length > 4000) {
        throw new Error("Invalid discussion response.")
    }
    return value as unknown as CurationMessage
}

export async function readCurationThread(collection: string, account: string, chainId: string, token: Token, cursor = "", signal?: AbortSignal): Promise<CurationThreadPage> {
    const url = new URL(endpoint(collection, "curation-thread"), window.location.origin)
    if (cursor) {
        if (cursor.length > 512) throw new Error("Invalid discussion cursor.")
        url.searchParams.set("cursor", cursor)
    }
    const raw = await readResponse(await fetch(url.toString(), {
        headers: auth(token, account, chainId), cache: "no-store", signal,
    }))
    if (!raw || typeof raw !== "object") throw new Error("Invalid discussion response.")
    const value = raw as Record<string, unknown>
    if (value.chainId !== chainId || value.collection !== collection || !Array.isArray(value.messages) ||
        value.messages.length > 30 || (value.nextCursor !== undefined && (typeof value.nextCursor !== "string" || value.nextCursor.length > 512))) {
        throw new Error("Invalid discussion response.")
    }
    const messages = value.messages.map(validMessage)
    if (new Set(messages.map((message) => message.id)).size !== messages.length) throw new Error("Invalid discussion response.")
    return { chainId, collection, messages, nextCursor: (value.nextCursor as string | undefined) ?? "" }
}

export async function sendCurationMessage(collection: string, account: string, chainId: string, token: Token, clientId: string, text: string): Promise<CurationMessage> {
    if (!messageIDPattern.test(clientId) || !text.trim() || new TextEncoder().encode(text.trim()).length > 4000) throw new Error("Write a message of up to 4,000 bytes.")
    const raw = await readResponse(await fetch(endpoint(collection, "curation-thread"), {
        method: "POST", headers: { ...auth(token, account, chainId), "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, text: text.trim() }), cache: "no-store",
    }))
    const message = validMessage(raw)
    if (message.sender !== account || message.text !== text.trim()) throw new Error("Invalid discussion response.")
    return message
}
