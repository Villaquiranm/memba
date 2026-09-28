package indexer

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const launchpadReorgLookback = int64(64)

type LaunchpadTailerConfig struct {
	RPCURL        string
	ChainID       string
	StartBlock    int64 // exact NFT realm deployment height, required
	Confirmations int64
	Interval      time.Duration
	Logger        *slog.Logger
}

// launchpadBlockSource is deliberately single-node. Legacy NFT failover can
// cross chain boundaries; this owner ledger requires identity proof on status
// and every block header before accepting a block's events.
type launchpadBlockSource interface {
	LatestHeight(context.Context, string) (int64, error)
	BlockHash(context.Context, string, int64) (string, error)
	BlockEvents(context.Context, int64) ([]GnoEvent, error)
}

type launchpadHTTPSource struct {
	client *http.Client
	url    string
}

func (s launchpadHTTPSource) LatestHeight(ctx context.Context, expectedChain string) (int64, error) {
	body, err := httpGet(ctx, s.client, s.url+"/status")
	if err != nil {
		return 0, err
	}
	var status struct {
		Result struct {
			NodeInfo struct {
				Network string `json:"network"`
			} `json:"node_info"`
			SyncInfo struct {
				LatestBlockHeight string `json:"latest_block_height"`
			} `json:"sync_info"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &status); err != nil {
		return 0, fmt.Errorf("launchpad status decode: %w", err)
	}
	if status.Result.NodeInfo.Network != expectedChain || expectedChain == "" {
		return 0, fmt.Errorf("launchpad RPC chain %q, want %q", status.Result.NodeInfo.Network, expectedChain)
	}
	height, err := strconv.ParseInt(status.Result.SyncInfo.LatestBlockHeight, 10, 64)
	if err != nil || height < 0 {
		return 0, fmt.Errorf("launchpad invalid latest height %q", status.Result.SyncInfo.LatestBlockHeight)
	}
	return height, nil
}

func (s launchpadHTTPSource) BlockHash(ctx context.Context, expectedChain string, height int64) (string, error) {
	body, err := httpGet(ctx, s.client, s.url+"/block?height="+strconv.FormatInt(height, 10))
	if err != nil {
		return "", err
	}
	var block struct {
		Result struct {
			BlockMeta struct {
				Header struct {
					ChainID string `json:"chain_id"`
				} `json:"header"`
			} `json:"block_meta"`
			Block struct {
				Header struct {
					ChainID string `json:"chain_id"`
				} `json:"header"`
			} `json:"block"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &block); err != nil {
		return "", fmt.Errorf("launchpad block decode: %w", err)
	}
	chainID := block.Result.BlockMeta.Header.ChainID
	if chainID == "" {
		chainID = block.Result.Block.Header.ChainID
	}
	if chainID != expectedChain || expectedChain == "" {
		return "", fmt.Errorf("launchpad block %d chain %q, want %q", height, chainID, expectedChain)
	}
	return parseBlockHash(body, height)
}

func (s launchpadHTTPSource) BlockEvents(ctx context.Context, height int64) ([]GnoEvent, error) {
	body, err := httpGet(ctx, s.client, s.url+"/block_results?height="+strconv.FormatInt(height, 10))
	if err != nil {
		return nil, err
	}
	return parseBlockResults(body, height)
}

// StartLaunchpadNFTTailer is opt-in and fail-closed. It never shares the
// legacy NFT cursor or its chain-agnostic tables. Operators must configure
// the exact realm deployment height before enabling it.
func StartLaunchpadNFTTailer(ctx context.Context, database *sql.DB, cfg LaunchpadTailerConfig) {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if strings.TrimSpace(cfg.ChainID) == "" || strings.TrimSpace(cfg.RPCURL) == "" || cfg.StartBlock <= 0 {
		cfg.Logger.Error("launchpad nft tailer: chain ID, RPC URL and deployment block are required")
		return
	}
	if cfg.Confirmations < 1 {
		cfg.Confirmations = 5
	}
	if cfg.Interval <= 0 {
		cfg.Interval = 3 * time.Second
	}
	src := launchpadHTTPSource{
		client: &http.Client{Timeout: 15 * time.Second},
		url:    strings.TrimRight(cfg.RPCURL, "/"),
	}
	go func() {
		cfg.Logger.Info("launchpad nft tailer: started", "chain_id", cfg.ChainID,
			"start_block", cfg.StartBlock, "confirmations", cfg.Confirmations)
		ticker := time.NewTicker(cfg.Interval)
		defer ticker.Stop()
		for {
			if err := launchpadTailOnce(ctx, database, cfg, src); err != nil && ctx.Err() == nil {
				cfg.Logger.Warn("launchpad nft tailer: retrying", "error", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
}

func launchpadTailOnce(ctx context.Context, db *sql.DB, cfg LaunchpadTailerConfig, src launchpadBlockSource) error {
	if cfg.ChainID == "" || cfg.StartBlock <= 0 {
		return fmt.Errorf("launchpad nft tailer: missing chain ID or deployment block")
	}
	latest, err := src.LatestHeight(ctx, cfg.ChainID)
	if err != nil {
		return err
	}
	var last sql.NullInt64
	if err := db.QueryRowContext(ctx, `SELECT MAX(height) FROM launchpad_nft_indexed_blocks
		WHERE chain_id=?`, cfg.ChainID).Scan(&last); err != nil {
		return err
	}
	cursor := cfg.StartBlock - 1
	if last.Valid {
		cursor = last.Int64
		if cursor < cfg.StartBlock {
			return fmt.Errorf("launchpad nft tailer: invalid cursor below deployment block")
		}
	}
	if cursor >= cfg.StartBlock {
		// Compare recent persisted hashes. A divergence beyond the bounded
		// window fails closed and needs an operator-led full rebuild.
		floor := cursor - launchpadReorgLookback + 1
		if floor < cfg.StartBlock {
			floor = cfg.StartBlock
		}
		ancestor := int64(-1)
		for h := cursor; h >= floor; h-- {
			var stored string
			if err := db.QueryRowContext(ctx, `SELECT hash FROM launchpad_nft_indexed_blocks
				WHERE chain_id=? AND height=?`, cfg.ChainID, h).Scan(&stored); err != nil {
				return fmt.Errorf("launchpad nft tailer: missing block %d: %w", h, err)
			}
			actual, err := src.BlockHash(ctx, cfg.ChainID, h)
			if err != nil {
				return err
			}
			if stored == actual {
				ancestor = h
				break
			}
		}
		if ancestor < 0 && floor != cfg.StartBlock {
			return fmt.Errorf("launchpad nft tailer: reorg exceeds %d-block recovery window", launchpadReorgLookback)
		}
		if ancestor < 0 {
			ancestor = cfg.StartBlock - 1
		}
		if ancestor < cursor {
			if err := rollbackLaunchpadTailerFromHeight(ctx, db, cfg.ChainID, ancestor+1); err != nil {
				return err
			}
			cursor = ancestor
		}
	}
	end := confirmedEnd(latest, cfg.Confirmations, cursor, maxBlocksPerCycle)
	for h := cursor + 1; h <= end; h++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		hash, err := src.BlockHash(ctx, cfg.ChainID, h)
		if err != nil {
			return err
		}
		events, err := src.BlockEvents(ctx, h)
		if err != nil {
			return err
		}
		if err := applyLaunchpadBlock(ctx, db, cfg.ChainID, h, hash, events); err != nil {
			return err
		}
	}
	return nil
}

func applyLaunchpadBlock(ctx context.Context, db *sql.DB, chainID string, height int64, hash string, events []GnoEvent) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, ev := range events {
		if ev.PkgPath != launchpadNFTRealm {
			continue
		}
		if ev.Block != height {
			return fmt.Errorf("launchpad block %d contains event attributed to block %d", height, ev.Block)
		}
		if err := applyLaunchpadOwnershipEventTx(ctx, tx, chainID, ev); err != nil {
			return fmt.Errorf("launchpad block %d event %d/%d: %w", height, ev.TxIndex, ev.EventIdx, err)
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO launchpad_nft_indexed_blocks (chain_id, height, hash)
		VALUES (?, ?, ?)`, chainID, height, hash); err != nil {
		return err
	}
	return tx.Commit()
}

func rollbackLaunchpadTailerFromHeight(ctx context.Context, db *sql.DB, chainID string, height int64) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, query := range []string{
		`DELETE FROM launchpad_nft_ownership_events WHERE chain_id=? AND event_block>=?`,
		`DELETE FROM launchpad_nft_indexed_blocks WHERE chain_id=? AND height>=?`,
	} {
		if _, err := tx.ExecContext(ctx, query, chainID, height); err != nil {
			return err
		}
	}
	return tx.Commit()
}
