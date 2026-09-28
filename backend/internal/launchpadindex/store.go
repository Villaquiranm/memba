package launchpadindex

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
)

var (
	ErrInvalidScope  = errors.New("invalid Launchpad publication scope")
	ErrStoreConflict = errors.New("conflicting Launchpad stored evidence")
)

// Scope isolates one publication generation of tokens/v1 on one chain. The
// publication identity and anchor must come from a separately verified
// AddPackage transaction; this package does not infer or verify publication.
type Scope struct {
	ChainID             string
	RealmPath           string
	PublicationHeight   int64
	PublicationHash     [32]byte
	PublicationIdentity string
}

// Cursor is the last durably recorded height and its RPC-reported block hash.
type Cursor struct {
	Height int64
	Hash   [32]byte
}

// Store owns Launchpad-only tables inside the caller's existing SQLite DB.
type Store struct {
	db    *sql.DB
	key   string
	scope Scope
}

func validScope(s Scope) bool {
	if s.RealmPath != TokenRealmPath || s.PublicationHeight <= 0 ||
		s.PublicationHash == ([32]byte{}) || !printableKey(s.ChainID, 128) ||
		!printableKey(s.PublicationIdentity, 128) {
		return false
	}
	return true
}

func printableKey(s string, max int) bool {
	if len(s) == 0 || len(s) > max {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] <= 0x20 || s[i] >= 0x7f {
			return false
		}
	}
	return true
}

func scopeKey(s Scope) string {
	encoded, _ := json.Marshal(struct {
		ChainID             string
		RealmPath           string
		PublicationHeight   int64
		PublicationHash     [32]byte
		PublicationIdentity string
	}{s.ChainID, s.RealmPath, s.PublicationHeight, s.PublicationHash, s.PublicationIdentity})
	hash := sha256.Sum256(append([]byte("memba-launchpad-scope-v1\x00"), encoded...))
	return hex.EncodeToString(hash[:])
}

// OpenStore registers or reopens an immutable scope. Call MigrateStore first.
// It never starts polling or serves the stored data to a user.
func OpenStore(ctx context.Context, db *sql.DB, scope Scope) (*Store, error) {
	if db == nil || !validScope(scope) {
		return nil, ErrInvalidScope
	}
	key := scopeKey(scope)
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin launchpad scope: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var chainID, realmPath, publicationIdentity string
	var publicationHeight int64
	var publicationHash []byte
	err = tx.QueryRowContext(ctx, `SELECT chain_id, realm_path, publication_height,
		publication_hash, publication_identity FROM launchpad_scopes WHERE scope_key = ?`, key).
		Scan(&chainID, &realmPath, &publicationHeight, &publicationHash, &publicationIdentity)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		_, err = tx.ExecContext(ctx, `INSERT INTO launchpad_scopes
			(scope_key, chain_id, realm_path, publication_height, publication_hash,
			 publication_identity, cursor_height, cursor_hash)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, key, scope.ChainID, scope.RealmPath,
			scope.PublicationHeight, scope.PublicationHash[:], scope.PublicationIdentity,
			scope.PublicationHeight, scope.PublicationHash[:])
		if err != nil {
			return nil, fmt.Errorf("register launchpad scope: %w", err)
		}
	case err != nil:
		return nil, fmt.Errorf("read launchpad scope: %w", err)
	case chainID != scope.ChainID || realmPath != scope.RealmPath ||
		publicationHeight != scope.PublicationHeight ||
		string(publicationHash) != string(scope.PublicationHash[:]) ||
		publicationIdentity != scope.PublicationIdentity:
		return nil, ErrStoreConflict
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit launchpad scope: %w", err)
	}
	return &Store{db: db, key: key, scope: scope}, nil
}

func (s *Store) Cursor(ctx context.Context) (Cursor, error) {
	if s == nil || s.db == nil {
		return Cursor{}, ErrInvalidScope
	}
	var height int64
	var rawHash []byte
	if err := s.db.QueryRowContext(ctx,
		`SELECT cursor_height, cursor_hash FROM launchpad_scopes WHERE scope_key = ?`, s.key).
		Scan(&height, &rawHash); err != nil {
		return Cursor{}, fmt.Errorf("read launchpad cursor: %w", err)
	}
	if height < s.scope.PublicationHeight || len(rawHash) != 32 {
		return Cursor{}, ErrStoreConflict
	}
	var hash [32]byte
	copy(hash[:], rawHash)
	return Cursor{Height: height, Hash: hash}, nil
}
