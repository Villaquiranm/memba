package indexer

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"strings"
)

// launchpadNFTRealm is intentionally exact. Events with the same names from
// other realms must never be allowed to change this ledger.
const launchpadNFTRealm = "gno.land/r/samcrew/launchpad/nft/v1"

type LaunchpadTokenOwnership struct {
	Collection string
	Number     int64
	Owner      string
	Status     string
	Block      int64
}

// ApplyLaunchpadOwnershipEvent applies one confirmed event in chain order.
// The caller must first verify the RPC node's chain ID and process every event
// from the collection's deployment block. Malformed or out-of-sequence events
// stop the cursor rather than silently producing an incorrect owner.
func ApplyLaunchpadOwnershipEvent(ctx context.Context, db *sql.DB, chainID string, ev GnoEvent) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := applyLaunchpadOwnershipEventTx(ctx, tx, chainID, ev); err != nil {
		return err
	}
	return tx.Commit()
}

func applyLaunchpadOwnershipEventTx(ctx context.Context, tx *sql.Tx, chainID string, ev GnoEvent) error {
	if ev.PkgPath != launchpadNFTRealm {
		return nil
	}
	var kind, from, to, actor, reason string
	switch ev.Type {
	case "LaunchpadNFTMinted":
		kind, to, actor = "minted", ev.Attr("recipient"), ev.Attr("recipient")
	case "LaunchpadNFTTransferred":
		kind, from, to, actor = "transferred", ev.Attr("from"), ev.Attr("to"), ev.Attr("actor")
	case "LaunchpadNFTBurned":
		kind, from, actor = "burned", ev.Attr("holder"), ev.Attr("holder")
	case "LaunchpadNFTRevoked":
		kind, from, actor, reason = "revoked", ev.Attr("holder"), ev.Attr("issuer"), ev.Attr("reason")
	default:
		return nil
	}
	chainID = strings.TrimSpace(chainID)
	collection := ev.Attr("collection")
	numberRaw := ev.Attr("number")
	number, err := strconv.ParseInt(numberRaw, 10, 64)
	if err != nil || number <= 0 || strconv.FormatInt(number, 10) != numberRaw ||
		chainID == "" || collection == "" || ev.Block <= 0 || ev.TxIndex < 0 || ev.EventIdx < 0 ||
		!validOwnershipAddress(actor) ||
		(to != "" && !validOwnershipAddress(to)) ||
		(from != "" && !validOwnershipAddress(from)) ||
		(kind == "revoked" && !validRevocationReason(reason)) {
		return fmt.Errorf("launchpad ownership: malformed %s event at %d/%d/%d", ev.Type, ev.Block, ev.TxIndex, ev.EventIdx)
	}

	// Replays must be harmless, including retries after a later event in the
	// same block failed. The primary key also rejects conflicting events at the
	// same chain coordinate.
	var existingCollection string
	var existingNumber int64
	var existingKind, existingFrom, existingTo, existingActor, existingReason string
	err = tx.QueryRowContext(ctx, `SELECT collection_id, token_number, kind, from_owner, to_owner, actor, reason
		FROM launchpad_nft_ownership_events WHERE chain_id=? AND event_block=? AND event_tx_index=? AND event_index=?`,
		chainID, ev.Block, ev.TxIndex, ev.EventIdx).Scan(
		&existingCollection, &existingNumber, &existingKind, &existingFrom, &existingTo, &existingActor, &existingReason)
	if err == nil {
		if existingCollection != collection || existingNumber != number || existingKind != kind ||
			existingFrom != from || existingTo != to || existingActor != actor || existingReason != reason {
			return fmt.Errorf("launchpad ownership: conflicting event at %d/%d/%d", ev.Block, ev.TxIndex, ev.EventIdx)
		}
		return nil
	}
	if err != sql.ErrNoRows {
		return err
	}

	var previousOwner, previousKind string
	var previousBlock int64
	var previousTx, previousIndex int
	err = tx.QueryRowContext(ctx, `SELECT to_owner, kind, event_block, event_tx_index, event_index
		FROM launchpad_nft_ownership_events
		WHERE chain_id=? AND collection_id=? AND token_number=?
		ORDER BY event_block DESC, event_tx_index DESC, event_index DESC LIMIT 1`,
		chainID, collection, number).Scan(&previousOwner, &previousKind, &previousBlock, &previousTx, &previousIndex)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if err == nil && (ev.Block < previousBlock ||
		(ev.Block == previousBlock && ev.TxIndex < previousTx) ||
		(ev.Block == previousBlock && ev.TxIndex == previousTx && ev.EventIdx <= previousIndex)) {
		return fmt.Errorf("launchpad ownership: out-of-order event for %s/%d", collection, number)
	}
	if kind == "minted" {
		if err != sql.ErrNoRows {
			return fmt.Errorf("launchpad ownership: duplicate mint for %s/%d", collection, number)
		}
	} else if err == sql.ErrNoRows || previousOwner == "" || previousOwner != from ||
		previousKind == "burned" || previousKind == "revoked" {
		return fmt.Errorf("launchpad ownership: invalid %s transition for %s/%d", kind, collection, number)
	}

	_, err = tx.ExecContext(ctx, `INSERT INTO launchpad_nft_ownership_events
		(chain_id, pkg_path, event_block, event_tx_index, event_index, collection_id,
		 token_number, kind, from_owner, to_owner, actor, reason)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		chainID, ev.PkgPath, ev.Block, ev.TxIndex, ev.EventIdx, collection, number,
		kind, from, to, actor, reason)
	if err != nil {
		return err
	}
	return nil
}

func validOwnershipAddress(s string) bool {
	return strings.HasPrefix(s, "g1") && len(s) >= 10 && len(s) <= 128 && !strings.ContainsAny(s, " \t\r\n")
}

func validRevocationReason(s string) bool {
	switch s {
	case "expired", "fraud", "eligibility_lost", "issuer_error", "other":
		return true
	default:
		return false
	}
}

// GetLaunchpadTokenOwnership returns the last confirmed event for one token.
// A retired token has an empty owner and an explicit burned/revoked status.
func GetLaunchpadTokenOwnership(ctx context.Context, db *sql.DB, chainID, collection string, number int64) (LaunchpadTokenOwnership, error) {
	var item LaunchpadTokenOwnership
	var kind string
	err := db.QueryRowContext(ctx, `SELECT collection_id, token_number, to_owner, kind, event_block
		FROM launchpad_nft_ownership_events
		WHERE chain_id=? AND collection_id=? AND token_number=?
		ORDER BY event_block DESC, event_tx_index DESC, event_index DESC LIMIT 1`,
		chainID, collection, number).Scan(&item.Collection, &item.Number, &item.Owner, &kind, &item.Block)
	if err != nil {
		return LaunchpadTokenOwnership{}, err
	}
	if kind == "burned" || kind == "revoked" {
		item.Status = kind
	} else {
		item.Status = "active"
	}
	return item, nil
}
