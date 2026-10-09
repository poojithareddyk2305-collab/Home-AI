import os
import re
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

import json
import time
import uuid

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from groq import Groq
from pydantic import BaseModel

import db
import docgen
import tools

GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
VISION_MODEL = os.getenv("GROQ_VISION_MODEL", "qwen/qwen3.8-27b")
MAX_TOOL_STEPS = 4
MAX_TOOL_CALLS = 3
client = Groq(api_key=os.getenv("GROQ_API_KEY"))

CREATOR_PROFILE = {
    "name": "Poojitha Reddy",
    "role": "Creator & Developer",
    "details": [
        "3rd Year B.Tech CSE",
        "PBR VITS College, Kavali",
    ],
    "bio": (
        "Built this AI chatbot as a college project to explore how large language "
        "models, real-time streaming, and modern web design come together in a "
        "real application — covering everything from the backend API to the "
        "chat UI you're using right now."
    ),
}

CREATE_VERB = r"(build|built|builds|building|make|made|makes|making|create|created|creates|creating|develop|developed|develops|developing|design|designed|designs|designing)"

CREATOR_QUESTION_PATTERN = re.compile(
    r"\b(who\s+" + CREATE_VERB + r"\s+(you|this|it)\b|"
    r"who\s+" + CREATE_VERB + r"\s+this\s+(app|bot|chatbot|assistant|project)\b|"
    r"your\s+(creator|developer|maker|builder)\b|"
    r"who\s+is\s+your\s+(creator|developer|maker)\b|"
    r"who['’]?s\s+behind\s+(you|this)\b)",
    re.IGNORECASE,
)

DEFAULT_SYSTEM_PROMPT = (
    "You are a helpful AI chatbot assistant. If asked who you are, say you are an AI "
    "chatbot built as a college project. Format replies in markdown where it helps "
    "(code blocks, lists, bold) but keep prose plain otherwise."
)

PERSONAS = {
    "default": {"name": "Default", "description": "Balanced, helpful assistant", "prompt": ""},
    "tutor": {
        "name": "Tutor",
        "description": "Explains step by step and checks understanding",
        "prompt": (
            "Act as a patient tutor. Explain concepts step by step with simple analogies and small examples. "
            "End with a short question or exercise that checks the student's understanding."
        ),
    },
    "coder": {
        "name": "Coder",
        "description": "Senior engineer: precise code and trade-offs",
        "prompt": (
            "Act as a senior software engineer. Be precise. Put code in fenced blocks with a language tag, "
            "mention edge cases and likely bugs, and note trade-offs briefly instead of rambling."
        ),
    },
    "interviewer": {
        "name": "Interviewer",
        "description": "Mock technical interview, one question at a time",
        "prompt": (
            "Act as a technical interviewer running a mock interview. Ask ONE question at a time and wait for the "
            "answer. After each answer give brief feedback and a score out of 10, then ask the next question, "
            "adapting the difficulty to how the candidate is doing."
        ),
    },
    "writer": {
        "name": "Writer",
        "description": "Creative writing partner",
        "prompt": (
            "Act as a creative writing partner. Write vividly and originally, match the tone the user asks for, "
            "and offer one or two alternative takes when it helps."
        ),
    },
    "concise": {
        "name": "Concise",
        "description": "Short answers, no fluff",
        "prompt": "Be extremely concise: answer in at most three sentences unless the user explicitly asks for more detail.",
    },
}

TOOL_GUIDANCE = (
    "You can use tools. Use web_search for anything recent, time-sensitive (prices, news, releases), or that you are "
    "not sure about; use get_weather for weather and calculator for any non-trivial arithmetic. Do not call tools for "
    "things you already know well. Search at most twice per question: if a search fails or finds nothing useful, "
    "do not keep retrying, answer with what you have.\n\n"
    "When the user asks for a document, file, report, PDF, doc, write-up or guide, call create_document and write the "
    "complete document yourself (clear title, ## sections, concise paragraphs, bullet lists, and a table when it helps). "
    "Never go looking for an existing file online. You may run one web_search first if current facts matter, but if "
    "search is unavailable still write the document from well-established knowledge, and put a short note in it that "
    "prices and specs should be verified. Never invent exact specs or prices; say where something varies or must be "
    "checked. After the document is created, reply with only two to four short lines: what it covers, and that it is "
    "ready to download as Word, PDF or Markdown. Do not paste the document into the chat.\n\n"
    "When your answer uses web results, write it like a professional briefing, never as bare links:\n"
    "1. Open with a direct one or two sentence summary that answers the question.\n"
    "2. Then give a short, well-organised breakdown. For prices or comparisons use a compact markdown table "
    "(for example Retailer | Price | Notes); otherwise use brief bullet points.\n"
    "3. Cite with the source number right after each claim, like [1] or [2][3].\n"
    "4. Quote prices and figures exactly as found, with the currency. Only state what the results support: if they "
    "do not contain the exact figure, say so plainly instead of guessing, and never claim a product or fact does not "
    "exist just because the results did not mention it.\n"
    "5. Finish with one short line of caveat or advice when the data may change or sources disagree "
    "(for example: prices vary by seller and configuration, so check the listing before buying)."
)

FINAL_NUDGE = (
    "Tool limit reached. Do not call any more tools. Write the final answer for the user now, using the search "
    "results already gathered, following the briefing format above. If the results were thin, say what you found "
    "and what is missing."
)


def has_image(messages: list[dict]) -> bool:
    for m in messages:
        content = m.get("content")
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "image_url":
                    return True
    return False


def extract_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") == "text")
    return ""


def is_creator_question(messages: list[dict]) -> bool:
    for m in reversed(messages):
        if m.get("role") == "user":
            return bool(CREATOR_QUESTION_PATTERN.search(extract_text(m.get("content"))))
    return False


app = FastAPI(title="AI Chatbot")
db.init_db()


@app.middleware("http")
async def no_cache_for_frontend(request, call_next):
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static"):
        response.headers["Cache-Control"] = "no-cache"
    return response


app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
def index():
    return FileResponse("static/index.html")


# ---------------------------------------------------------------- chat
class ChatRequest(BaseModel):
    messages: list[dict]  # [{role: "user"|"assistant", content: "..."}]
    system_prompt: str | None = None
    persona: str | None = None
    tools_enabled: bool = True


@app.get("/settings/default-system-prompt")
def default_system_prompt():
    return {"system_prompt": DEFAULT_SYSTEM_PROMPT}


@app.get("/personas")
def personas():
    return [{"id": k, "name": v["name"], "description": v["description"]} for k, v in PERSONAS.items()]


def sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


def build_system_prompt(payload: ChatRequest, with_tools: bool) -> str:
    base = (payload.system_prompt or "").strip() or DEFAULT_SYSTEM_PROMPT
    parts = [base]
    persona = PERSONAS.get(payload.persona or "default")
    if persona and persona["prompt"]:
        parts.append(persona["prompt"])
    parts.append(f"Today's date is {datetime.now().strftime('%A, %d %B %Y')}.")
    parts.append(
        "Never use LaTeX math delimiters like \\( \\) or $$; write math in plain text (e.g. 12.5 x 4 = 50) or in code "
        "formatting. When citing sources use plain ASCII square brackets like [1], never fullwidth brackets."
    )
    if with_tools:
        parts.append(TOOL_GUIDANCE)
    return "\n\n".join(parts)


def stream_chunks(kwargs: dict, swallow_errors: bool = False):
    """Streams a completion. On the forced final step the API can still reject a model that insists on
    calling another tool; swallow that so the caller falls back to a plain note instead of a hard error."""
    try:
        yield from client.chat.completions.create(**kwargs)
    except Exception:
        if not swallow_errors:
            raise


def run_chat(payload: ChatRequest, model: str, use_tools: bool):
    started = time.time()
    messages = [{"role": "system", "content": build_system_prompt(payload, use_tools)}] + payload.messages
    usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    sources_seen: list[dict] = []
    seen_urls: set[str] = set()
    tool_calls_made = 0
    answered = False

    try:
        for step in range(MAX_TOOL_STEPS):
            kwargs = {"model": model, "messages": messages, "stream": True}
            final_step = step == MAX_TOOL_STEPS - 1 or tool_calls_made >= MAX_TOOL_CALLS
            if use_tools and not final_step:
                kwargs["tools"] = tools.TOOL_SCHEMAS
                kwargs["tool_choice"] = "auto"
            elif use_tools and tool_calls_made:
                kwargs["messages"] = messages + [{"role": "system", "content": FINAL_NUDGE}]

            text = ""
            calls: dict[int, dict] = {}
            for chunk in stream_chunks(kwargs, swallow_errors=final_step and tool_calls_made > 0):
                chunk_usage = getattr(chunk, "usage", None) or getattr(getattr(chunk, "x_groq", None), "usage", None)
                if chunk_usage:
                    usage["prompt_tokens"] += getattr(chunk_usage, "prompt_tokens", 0) or 0
                    usage["completion_tokens"] += getattr(chunk_usage, "completion_tokens", 0) or 0
                    usage["total_tokens"] += getattr(chunk_usage, "total_tokens", 0) or 0
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                if delta.content:
                    text += delta.content
                    answered = True
                    yield sse({"delta": delta.content})
                for tc in delta.tool_calls or []:
                    entry = calls.setdefault(tc.index, {"id": "", "name": "", "args": ""})
                    if tc.id:
                        entry["id"] = tc.id
                    if tc.function and tc.function.name:
                        entry["name"] += tc.function.name
                    if tc.function and tc.function.arguments:
                        entry["args"] += tc.function.arguments

            if not calls:
                break

            ordered = [calls[i] for i in sorted(calls)]
            messages.append(
                {
                    "role": "assistant",
                    "content": text or None,
                    "tool_calls": [
                        {"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c["args"] or "{}"}}
                        for c in ordered
                    ],
                }
            )
            for c in ordered:
                try:
                    args = json.loads(c["args"] or "{}")
                except json.JSONDecodeError:
                    args = {}
                label = tools.TOOL_LABELS.get(c["name"], lambda a: c["name"])(args)
                yield sse({"tool_start": {"id": c["id"], "name": c["name"], "label": label}})
                if c["name"] == "create_document":
                    doc_title = str(args.get("title", "")).strip()[:120]
                    doc_body = str(args.get("content", "")).strip()
                    new_sources = []
                    if not doc_title or len(doc_body) < 40:
                        result_text = "Could not create the document: provide both a title and the full document content."
                        summary = "Failed"
                    else:
                        yield sse({"document": {"id": c["id"] or uuid.uuid4().hex, "title": doc_title, "markdown": doc_body}})
                        summary = f"{len(doc_body.split())} words"
                        result_text = (
                            f'The document "{doc_title}" was created and is shown to the user as a downloadable card '
                            "(Word, PDF, Markdown). Now reply in two to four short lines saying what it covers and that "
                            "it is ready to download. Do not repeat the document."
                        )
                else:
                    result_text, summary, new_sources = tools.run_tool(c["name"], args, len(sources_seen), seen_urls)
                tool_calls_made += 1
                if new_sources:
                    sources_seen.extend(new_sources)
                    yield sse({"sources": new_sources})
                yield sse({"tool_result": {"id": c["id"], "name": c["name"], "summary": summary}})
                messages.append({"role": "tool", "tool_call_id": c["id"], "content": result_text})

        if not answered:
            note = "I couldn't put together a written answer this time, please try asking again."
            if sources_seen:
                note += " The sources I found are listed below."
            yield sse({"delta": note})

        yield sse(
            {
                "stats": {
                    "model": model,
                    "server_ms": int((time.time() - started) * 1000),
                    "tool_calls": tool_calls_made,
                    **usage,
                }
            }
        )
    except Exception as e:
        yield sse({"error": f"{type(e).__name__}: {e}"})
    yield "data: [DONE]\n\n"


@app.post("/chat")
def chat(payload: ChatRequest):
    if is_creator_question(payload.messages):

        def profile_stream():
            yield sse({"profile": CREATOR_PROFILE})
            yield "data: [DONE]\n\n"

        return StreamingResponse(profile_stream(), media_type="text/event-stream")

    vision = has_image(payload.messages)
    model = VISION_MODEL if vision else GROQ_MODEL
    use_tools = payload.tools_enabled and not vision
    return StreamingResponse(run_chat(payload, model, use_tools), media_type="text/event-stream")


# ---------------------------------------------------------------- documents
class DocumentRequest(BaseModel):
    title: str
    markdown: str


@app.post("/documents/docx")
def document_docx(req: DocumentRequest):
    if len(req.markdown) > 200_000:
        raise HTTPException(status_code=413, detail="Document is too large.")
    data = docgen.markdown_to_docx(req.title.strip() or "Document", req.markdown)
    name = re.sub(r"[^A-Za-z0-9]+", "-", req.title).strip("-").lower()[:50] or "document"
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{name}.docx"'},
    )


# ---------------------------------------------------------------- accounts & synced history
class Credentials(BaseModel):
    username: str
    password: str


USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")


def current_user(authorization: str | None = Header(default=None)) -> tuple[int, str]:
    token = authorization[7:] if authorization and authorization.startswith("Bearer ") else None
    user = db.user_from_token(token)
    if not user:
        raise HTTPException(status_code=401, detail="Please sign in again.")
    return user


@app.post("/auth/register")
def register(creds: Credentials):
    if not USERNAME_RE.match(creds.username):
        raise HTTPException(status_code=400, detail="Username must be 3-32 characters: letters, numbers, . _ -")
    if len(creds.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters.")
    user_id = db.create_user(creds.username, creds.password)
    if user_id is None:
        raise HTTPException(status_code=409, detail="That username is already taken.")
    return {"token": db.create_token(user_id), "username": creds.username}


@app.post("/auth/login")
def login(creds: Credentials):
    user = db.verify_user(creds.username, creds.password)
    if not user:
        raise HTTPException(status_code=401, detail="Wrong username or password.")
    return {"token": db.create_token(user[0]), "username": user[1]}


@app.get("/auth/me")
def me(user=Depends(current_user)):
    return {"username": user[1]}


@app.post("/auth/logout")
def logout(authorization: str | None = Header(default=None)):
    if authorization and authorization.startswith("Bearer "):
        db.delete_token(authorization[7:])
    return {"ok": True}


class ChatData(BaseModel):
    data: dict


@app.get("/chats")
def get_chats(user=Depends(current_user)):
    return db.list_chats(user[0])


@app.put("/chats/{chat_id}")
def put_chat(chat_id: str, body: ChatData, user=Depends(current_user)):
    db.upsert_chat(user[0], chat_id, body.data)
    return {"ok": True}


@app.delete("/chats/{chat_id}")
def remove_chat(chat_id: str, user=Depends(current_user)):
    db.delete_chat(user[0], chat_id)
    return {"ok": True}
