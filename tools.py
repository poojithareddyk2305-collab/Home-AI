"""Tools the model can call: web search, weather, calculator."""
import ast
import html
import math
import operator
import os
import re
import threading
import time
from urllib.parse import parse_qs, unquote, urlparse

import httpx

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
}

TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": (
                "Search the web for current or factual information (news, recent events, prices, "
                "sports, releases, anything you are unsure about). Returns numbered results."
            ),
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string", "description": "A concise search query."}},
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get the current weather and a 3-day forecast for a city or place name.",
            "parameters": {
                "type": "object",
                "properties": {"location": {"type": "string", "description": "City or place, e.g. 'Kavali' or 'Paris'."}},
                "required": ["location"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_document",
            "description": (
                "Create a downloadable document file (report, guide, summary, comparison, notes, study material, "
                "résumé, letter...) that the user can download as Word, PDF or Markdown. Use this whenever the user "
                "asks for a document, file, report, PDF, doc or write-up. You write the whole document yourself; do "
                "NOT search the web for an existing file."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Short document title."},
                    "content": {
                        "type": "string",
                        "description": (
                            "The complete document in Markdown: ## section headings, short paragraphs, bullet lists, "
                            "and tables where useful. Do not repeat the title as a heading."
                        ),
                    },
                },
                "required": ["title", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "calculator",
            "description": (
                "Evaluate a math expression exactly. Supports + - * / // % **, parentheses, "
                "sqrt, sin, cos, tan, log, log10, abs, round, floor, ceil, and the constants pi and e."
            ),
            "parameters": {
                "type": "object",
                "properties": {"expression": {"type": "string", "description": "e.g. '(12.5 * 4) ** 2 / 7'"}},
                "required": ["expression"],
            },
        },
    },
]

TOOL_LABELS = {
    "web_search": lambda a: f'Searching the web for "{a.get("query", "")}"',
    "get_weather": lambda a: f'Checking weather in {a.get("location", "")}',
    "calculator": lambda a: f'Calculating {a.get("expression", "")}',
    "create_document": lambda a: f'Creating document "{a.get("title", "")}"',
}


# ---------- web search ----------
def _clean(text: str) -> str:
    text = re.sub(r"<[^>]+>", "", text)
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def _real_url(href: str) -> str:
    href = html.unescape(href)
    if href.startswith("//"):
        href = "https:" + href
    if "uddg=" in href:
        qs = parse_qs(urlparse(href).query)
        if qs.get("uddg"):
            return unquote(qs["uddg"][0])
    return href


_ddg_blocked_until = 0.0  # DuckDuckGo answers 202 (bot check) when it rate-limits; skip it for a while
_ddg_last_call = 0.0
_ddg_lock = threading.Lock()
_cache: dict[str, tuple[float, list[dict]]] = {}
CACHE_TTL = 600


def _search_tavily(query: str, limit: int) -> list[dict]:
    r = httpx.post(
        "https://api.tavily.com/search",
        json={"query": query, "max_results": limit, "search_depth": "basic"},
        headers={"Authorization": f"Bearer {os.getenv('TAVILY_API_KEY')}"},
        timeout=20,
    )
    r.raise_for_status()
    return [
        {"title": x.get("title", ""), "url": x.get("url", ""), "snippet": _clean(x.get("content", ""))[:500]}
        for x in r.json().get("results", [])
    ]


def _ddg_request(query: str) -> httpx.Response:
    return httpx.post(
        "https://html.duckduckgo.com/html/", data={"q": query}, headers=HEADERS, timeout=15, follow_redirects=True
    )


def _search_ddg(query: str, limit: int) -> list[dict]:
    global _ddg_blocked_until, _ddg_last_call
    with _ddg_lock:  # one request at a time, spaced out, so we don't trip DuckDuckGo's rate limit
        if time.time() < _ddg_blocked_until:
            raise RuntimeError("duckduckgo cooling down")
        wait = 1.5 - (time.time() - _ddg_last_call)
        if wait > 0:
            time.sleep(wait)
        r = _ddg_request(query)
        if r.status_code != 200:  # bot-check page; back off once, then give up for a while
            time.sleep(2.5)
            r = _ddg_request(query)
        _ddg_last_call = time.time()
        if r.status_code != 200:
            _ddg_blocked_until = time.time() + 180
            raise RuntimeError(f"duckduckgo blocked ({r.status_code})")
    results = []
    for block in re.split(r'<div class="result results_links', r.text)[1:]:
        title = re.search(r'class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', block, re.S)
        if not title:
            continue
        snippet = re.search(r'class="result__snippet"[^>]*>(.*?)</a>', block, re.S)
        url = _real_url(title.group(1))
        if "duckduckgo.com/y.js" in url:  # ad
            continue
        results.append(
            {"title": _clean(title.group(2)), "url": url, "snippet": _clean(snippet.group(1)) if snippet else ""}
        )
        if len(results) >= limit:
            break
    return results


def web_search(query: str, limit: int = 5) -> list[dict]:
    """Uses Tavily when TAVILY_API_KEY is set (most reliable), otherwise DuckDuckGo.
    Returns [] if a provider worked but found nothing; raises if every provider failed."""
    key = query.strip().lower()
    cached = _cache.get(key)
    if cached and time.time() - cached[0] < CACHE_TTL:
        return cached[1]
    providers = []
    if os.getenv("TAVILY_API_KEY"):
        providers.append(_search_tavily)
    providers.append(_search_ddg)
    worked = False
    for provider in providers:
        try:
            results = provider(query, limit)
        except Exception:
            continue
        worked = True
        if results:
            _cache[key] = (time.time(), results)
            return results
    if not worked:
        raise RuntimeError("all search providers failed or were blocked")
    return []


# ---------- weather ----------
WEATHER_CODES = {
    0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "rime fog",
    51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
    71: "light snow", 73: "snow", 75: "heavy snow", 80: "rain showers", 81: "heavy rain showers",
    82: "violent rain showers", 95: "thunderstorm", 96: "thunderstorm with hail", 99: "severe thunderstorm with hail",
}


def get_weather(location: str) -> str:
    geo = httpx.get(
        "https://geocoding-api.open-meteo.com/v1/search", params={"name": location, "count": 1}, timeout=15
    ).json()
    if not geo.get("results"):
        return f"Could not find a place called '{location}'."
    place = geo["results"][0]
    wx = httpx.get(
        "https://api.open-meteo.com/v1/forecast",
        params={
            "latitude": place["latitude"],
            "longitude": place["longitude"],
            "current": "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
            "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code",
            "timezone": "auto",
            "forecast_days": 3,
        },
        timeout=15,
    ).json()
    cur, daily = wx["current"], wx["daily"]
    name = ", ".join(x for x in [place.get("name"), place.get("admin1"), place.get("country")] if x)
    lines = [
        f"Weather for {name} (as of {cur['time']} local time):",
        f"Now: {cur['temperature_2m']}°C (feels like {cur['apparent_temperature']}°C), "
        f"{WEATHER_CODES.get(cur['weather_code'], 'unknown conditions')}, humidity {cur['relative_humidity_2m']}%, "
        f"wind {cur['wind_speed_10m']} km/h, precipitation {cur['precipitation']} mm.",
        "Forecast:",
    ]
    for i, day in enumerate(daily["time"]):
        lines.append(
            f"- {day}: {daily['temperature_2m_min'][i]}–{daily['temperature_2m_max'][i]}°C, "
            f"{WEATHER_CODES.get(daily['weather_code'][i], 'unknown')}, "
            f"rain chance {daily['precipitation_probability_max'][i]}%"
        )
    return "\n".join(lines)


# ---------- calculator (safe AST evaluation, no eval) ----------
_BIN = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod, ast.Pow: operator.pow,
}
_UNARY = {ast.UAdd: operator.pos, ast.USub: operator.neg}
_FUNCS = {
    "sqrt": math.sqrt, "sin": math.sin, "cos": math.cos, "tan": math.tan, "log": math.log, "log10": math.log10,
    "abs": abs, "round": round, "floor": math.floor, "ceil": math.ceil,
}
_CONSTS = {"pi": math.pi, "e": math.e}


def _eval(node):
    if isinstance(node, ast.Expression):
        return _eval(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in _BIN:
        left, right = _eval(node.left), _eval(node.right)
        if isinstance(node.op, ast.Pow) and abs(right) > 1000:
            raise ValueError("exponent too large")
        return _BIN[type(node.op)](left, right)
    if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY:
        return _UNARY[type(node.op)](_eval(node.operand))
    if isinstance(node, ast.Name) and node.id in _CONSTS:
        return _CONSTS[node.id]
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in _FUNCS and not node.keywords:
        return _FUNCS[node.func.id](*[_eval(a) for a in node.args])
    raise ValueError("unsupported expression")


def calculator(expression: str) -> str:
    expr = expression.replace("^", "**").replace("×", "*").replace("÷", "/")
    value = _eval(ast.parse(expr.strip(), mode="eval"))
    if isinstance(value, float) and value.is_integer() and abs(value) < 1e15:
        value = int(value)
    return f"{expression} = {value}"


# ---------- dispatcher ----------
def run_tool(name: str, args: dict, source_offset: int = 0, seen_urls: set | None = None):
    """Returns (text_for_model, short_summary_for_ui, sources)."""
    seen_urls = seen_urls if seen_urls is not None else set()
    try:
        if name == "web_search":
            try:
                results = web_search(args.get("query", ""))
            except RuntimeError:
                return (
                    "Web search is temporarily unavailable, so you could NOT check anything live. Do not retry. "
                    "Tell the user plainly, in your first sentence, that live search could not be reached right now. "
                    "Do not state or guess prices, availability, release status, specs, or whether a product or model "
                    "exists. If the user asked for a document, file or report, STILL call create_document now: write it "
                    "from well-established general knowledge only (what to look for, how to compare, categories of "
                    "features), use placeholders like 'check the current listing' instead of specific prices or unconfirmed "
                    "specs, and include a note near the top that live data could not be retrieved and details must be "
                    "verified. Otherwise keep the whole reply to 3-5 short lines: say search is unavailable, suggest "
                    "where to check (the official site and major retailers), and invite them to ask again in a few minutes.",
                    "Search unavailable",
                    [],
                )
            results = [r for r in results if r["url"] not in seen_urls]
            if not results:
                return (
                    "No new results were found. Do not keep searching; use what you already have and say what is missing.",
                    "No results",
                    [],
                )
            seen_urls.update(r["url"] for r in results)
            text = "\n\n".join(
                f"[{source_offset + i + 1}] {r['title']}\n{r['snippet']}\nURL: {r['url']}" for i, r in enumerate(results)
            )
            sources = [{"title": r["title"], "url": r["url"]} for r in results]
            return text, f"{len(results)} results", sources
        if name == "get_weather":
            text = get_weather(args.get("location", ""))
            return text, text.split("\n")[1][:80] if "\n" in text else text, []
        if name == "calculator":
            text = calculator(args.get("expression", ""))
            return text, text, []
        return f"Unknown tool: {name}", "Unknown tool", []
    except Exception as e:  # tool failures are reported to the model, not raised
        return f"Tool error: {e}", "Failed", []
