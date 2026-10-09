"""SQLite storage for user accounts and synced chat history (stdlib only)."""
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time

DB_PATH = os.getenv("DATABASE_PATH", os.path.join(os.path.dirname(os.path.abspath(__file__)), "chatbot.db"))
TOKEN_TTL = 60 * 60 * 24 * 30  # 30 days


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with _conn() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                created_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tokens (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chats (
                id TEXT NOT NULL,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                data TEXT NOT NULL,
                updated_at REAL NOT NULL,
                PRIMARY KEY (id, user_id)
            );
            """
        )


def _hash(password: str, salt: bytes) -> str:
    return hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32).hex()


def create_user(username: str, password: str) -> int | None:
    salt = secrets.token_bytes(16)
    try:
        with _conn() as c:
            cur = c.execute(
                "INSERT INTO users (username, salt, password_hash, created_at) VALUES (?, ?, ?, ?)",
                (username, salt.hex(), _hash(password, salt), time.time()),
            )
            return cur.lastrowid
    except sqlite3.IntegrityError:
        return None


def verify_user(username: str, password: str) -> tuple[int, str] | None:
    with _conn() as c:
        row = c.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    if not row:
        # still burn a hash so timing doesn't reveal which usernames exist
        _hash(password, b"\x00" * 16)
        return None
    if hmac.compare_digest(_hash(password, bytes.fromhex(row["salt"])), row["password_hash"]):
        return row["id"], row["username"]
    return None


def create_token(user_id: int) -> str:
    token = secrets.token_hex(32)
    with _conn() as c:
        c.execute("INSERT INTO tokens (token, user_id, created_at) VALUES (?, ?, ?)", (token, user_id, time.time()))
    return token


def user_from_token(token: str | None) -> tuple[int, str] | None:
    if not token:
        return None
    with _conn() as c:
        row = c.execute(
            "SELECT users.id, users.username, tokens.created_at FROM tokens "
            "JOIN users ON users.id = tokens.user_id WHERE tokens.token = ?",
            (token,),
        ).fetchone()
    if not row or time.time() - row["created_at"] > TOKEN_TTL:
        return None
    return row["id"], row["username"]


def delete_token(token: str) -> None:
    with _conn() as c:
        c.execute("DELETE FROM tokens WHERE token = ?", (token,))


def list_chats(user_id: int) -> list[dict]:
    with _conn() as c:
        rows = c.execute("SELECT data FROM chats WHERE user_id = ? ORDER BY updated_at DESC", (user_id,)).fetchall()
    return [json.loads(r["data"]) for r in rows]


def upsert_chat(user_id: int, chat_id: str, data: dict) -> None:
    with _conn() as c:
        c.execute(
            "INSERT INTO chats (id, user_id, data, updated_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(id, user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
            (chat_id, user_id, json.dumps(data), time.time()),
        )


def delete_chat(user_id: int, chat_id: str) -> None:
    with _conn() as c:
        c.execute("DELETE FROM chats WHERE id = ? AND user_id = ?", (chat_id, user_id))
