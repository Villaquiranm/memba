/** Reviewed creator reveal and explicit metadata freeze for committed collections. */
import { clearGovernanceReceipt, type GovernanceScope } from "./dao/governanceRecovery"
import { doContractBroadcast, type AminoMsg } from "./grc20"
import { baseURICommitment } from "./launchpadCommitments"
import { getLaunchpadNftCollection, type LaunchpadNftCollection } from "./launchpadNft"
import { LAUNCHPAD_NFT_PATH } from "./nftConfig"
import type { SignRequest } from "../os/sign/signer"

export const NFT_METADATA_GAS_WANTED = 50_000_000
const STORAGE_CAP = 1_000_000

function scope(chainId: string, collection: LaunchpadNftCollection, operation: "reveal-metadata" | "freeze-metadata"): GovernanceScope {
    return { chainId, realmPath: LAUNCHPAD_NFT_PATH, caller: collection.creator, operation: `${operation}:${collection.id}` }
}

export function revealMetadataScope(chainId: string, collection: LaunchpadNftCollection): GovernanceScope {
    return scope(chainId, collection, "reveal-metadata")
}

export function freezeMetadataScope(chainId: string, collection: LaunchpadNftCollection): GovernanceScope {
    return scope(chainId, collection, "freeze-metadata")
}

function assertRevealing(collection: LaunchpadNftCollection, creator: string): void {
    if (collection.creator !== creator || collection.metadataMode !== "reveal_base" || collection.revealed ||
        collection.metadataFrozen || collection.baseURI !== "" || collection.minted !== 0n) {
        throw new Error("This collection is not awaiting its creator's first reveal.")
    }
}

function assertFreezing(collection: LaunchpadNftCollection, creator: string): void {
    if (collection.creator !== creator || collection.metadataMode !== "reveal_base" || !collection.revealed ||
        collection.metadataFrozen || !collection.baseURI) throw new Error("This collection cannot be frozen by this wallet.")
}

function msg(creator: string, func: "Reveal" | "FreezeMetadata", args: string[]): AminoMsg {
    return { type: "vm/MsgCall", value: { caller: creator, send: "", pkg_path: LAUNCHPAD_NFT_PATH,
        func, args, max_deposit: `${STORAGE_CAP}ugnot` } }
}

export async function prepareRevealMetadataRequest(input: { collection: LaunchpadNftCollection; creator: string;
    baseURI: string; rpcUrl: string; chainId: string; estimatedGasFeeUgnot: number; onSettled?: () => void }): Promise<SignRequest> {
    const { collection, creator, baseURI, rpcUrl, chainId, estimatedGasFeeUgnot } = input
    if (!Number.isSafeInteger(estimatedGasFeeUgnot) || estimatedGasFeeUgnot <= 0) throw new Error("Could not estimate the network fee.")
    assertRevealing(collection, creator)
    if (!baseURI.startsWith("ipfs://")) throw new Error("Reveal requires the committed IPFS base URI.")
    const hash = await baseURICommitment(baseURI)
    if (hash !== collection.baseURICommitment) throw new Error("This IPFS URI does not match the collection's permanent SHA-256 commitment.")
    const call = msg(creator, "Reveal", [collection.id, baseURI])
    const receipt = revealMetadataScope(chainId, collection)
    return {
        title: "Reveal NFT metadata", summary: `${collection.name} · reveal the committed IPFS base URI`,
        lines: () => [["Collection", `${collection.name} (${collection.id})`], ["Creator", creator],
            ["Committed SHA-256", collection.baseURICommitment], ["Matching base URI", baseURI],
            ["First token URI", `${baseURI}1.json`], ["Provenance manifest hash", collection.provenanceHash],
            ["Realm", LAUNCHPAD_NFT_PATH], ["Network", chainId],
            ["Gas limit", NFT_METADATA_GAS_WANTED.toLocaleString()],
            ["Estimated gas fee", `${estimatedGasFeeUgnot.toLocaleString()} ugnot`],
            ["Storage deposit cap", `${STORAGE_CAP.toLocaleString()} ugnot`]],
        warns: ["The realm verifies the exact base URI bytes against the creation commitment. It does not verify the media files or provenance manifest. Check the entire collection before signing.",
            "Reveal is one-time. It enables minting; use the separate metadata freeze action to record finalization."],
        acks: ["I checked the committed IPFS URI, first token path, content availability, provenance claim and network."],
        label: () => `Reveal ${collection.id} metadata`, receipt, prepare: () => ({ msgs: [call] }),
        recheck: async () => {
            const fresh = await getLaunchpadNftCollection(rpcUrl, collection.id)
            assertRevealing(fresh, creator)
            if (fresh.baseURICommitment !== hash || fresh.provenanceHash !== collection.provenanceHash ||
                fresh.placeholderURI !== collection.placeholderURI) throw new Error("Collection commitment changed. Refresh before signing.")
        },
        send: (_choice, beforeSign) => doContractBroadcast([call], `Reveal ${collection.id} metadata`,
            { gasWanted: NFT_METADATA_GAS_WANTED, retry: false, beforeSign }),
        verify: async () => {
            const fresh = await getLaunchpadNftCollection(rpcUrl, collection.id)
            return fresh.creator === creator && fresh.metadataMode === "reveal_base" && fresh.revealed &&
                !fresh.metadataFrozen && fresh.baseURI === baseURI && fresh.baseURICommitment === hash
        },
        onSettled: (outcome) => {
            if (outcome === "confirmed") { try { clearGovernanceReceipt(receipt) } catch { /* retain conservative lock */ } }
            input.onSettled?.()
        },
    }
}

export function freezeMetadataRequest(input: { collection: LaunchpadNftCollection; creator: string;
    rpcUrl: string; chainId: string; estimatedGasFeeUgnot: number; onSettled?: () => void }): SignRequest {
    const { collection, creator, rpcUrl, chainId, estimatedGasFeeUgnot } = input
    if (!Number.isSafeInteger(estimatedGasFeeUgnot) || estimatedGasFeeUgnot <= 0) throw new Error("Could not estimate the network fee.")
    assertFreezing(collection, creator)
    const call = msg(creator, "FreezeMetadata", [collection.id])
    const receipt = freezeMetadataScope(chainId, collection)
    return {
        title: "Freeze NFT metadata", summary: `${collection.name} · finalize revealed metadata`,
        lines: () => [["Collection", `${collection.name} (${collection.id})`], ["Creator", creator],
            ["Revealed base URI", collection.baseURI], ["SHA-256 commitment", collection.baseURICommitment],
            ["Provenance manifest hash", collection.provenanceHash], ["Realm", LAUNCHPAD_NFT_PATH], ["Network", chainId],
            ["Gas limit", NFT_METADATA_GAS_WANTED.toLocaleString()],
            ["Estimated gas fee", `${estimatedGasFeeUgnot.toLocaleString()} ugnot`],
            ["Storage deposit cap", `${STORAGE_CAP.toLocaleString()} ugnot`]],
        warns: ["This action permanently marks metadata frozen. The realm does not check file availability or provenance claims; verify the revealed collection before signing."],
        acks: ["I checked the revealed metadata, commitment, permanence and network."],
        label: () => `Freeze ${collection.id} metadata`, receipt, prepare: () => ({ msgs: [call] }),
        recheck: async () => {
            const fresh = await getLaunchpadNftCollection(rpcUrl, collection.id)
            assertFreezing(fresh, creator)
            if (fresh.baseURI !== collection.baseURI || fresh.baseURICommitment !== collection.baseURICommitment ||
                fresh.provenanceHash !== collection.provenanceHash) throw new Error("Collection metadata changed. Refresh before signing.")
        },
        send: (_choice, beforeSign) => doContractBroadcast([call], `Freeze ${collection.id} metadata`,
            { gasWanted: NFT_METADATA_GAS_WANTED, retry: false, beforeSign }),
        verify: async () => {
            const fresh = await getLaunchpadNftCollection(rpcUrl, collection.id)
            return fresh.creator === creator && fresh.revealed && fresh.metadataFrozen &&
                fresh.metadataMode === "reveal_base" && fresh.baseURI === collection.baseURI &&
                fresh.baseURICommitment === collection.baseURICommitment && fresh.provenanceHash === collection.provenanceHash
        },
        onSettled: (outcome) => {
            if (outcome === "confirmed") { try { clearGovernanceReceipt(receipt) } catch { /* retain conservative lock */ } }
            input.onSettled?.()
        },
    }
}
