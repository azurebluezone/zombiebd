// =============================================================================
// Public API MCP Server v2.0
// Follows Model Context Protocol (MCP) specification
// Transport: Streamable HTTP (POST /mcp)
// Protocol: JSON-RPC 2.0
// =============================================================================
//
// Free public APIs (NO API keys required):
//   StackOverflow — Search questions, get answers, explore tags
//   Weather       — Open-Meteo: Current weather, forecasts, historical
//   Wikipedia     — Search articles, summaries, full content
//   REST Countries — Country info, flags, currencies, dial codes
//   Currency      — FrankFurter: Live exchange rates (ECB data)
//   Crypto        — CoinGecko: Live crypto prices
//   IP Geolocation — IP-API: Location from IP address
//   QR Code       — qr-server: Generate QR codes from text/URL
//
// =============================================================================

const http = require("http");
// Dedicated env var ONLY — the generic process.env.PORT is deliberately NOT
// used: this server is spawned as a CHILD of start.js (which sets PORT=3000
// for the main server in .env), so inheriting PORT would make us try to bind
// the MAIN SERVER's port and crash with EADDRINUSE.
const PORT = parseInt(process.env.PUBLIC_API_MCP_PORT || "3002", 10);

// ─── MCP Protocol Constants ───────────────────────────────────────────────
const MCP_PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "public-api-mcp", version: "2.0.0" };

// ─── HTTP Fetch Helper ─────────────────────────────────────────────────────
async function fetchJSON(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 15000);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "PublicAPI-MCP/2.0", Accept: "application/json", ...options.headers },
      signal: controller.signal,
      ...options,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function weatherCodeToDescription(code) {
  const d = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Rime fog", 51: "Light drizzle", 53: "Moderate drizzle",
    55: "Dense drizzle", 61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
    71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow",
    80: "Rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
    95: "Thunderstorm", 96: "Thunderstorm + hail", 99: "Thunderstorm + heavy hail",
  };
  return d[code] || `Code ${code}`;
}

// ─── Tool Definitions ──────────────────────────────────────────────────────
const TOOLS = [
  // ══════════════════════════════════════════════════════════════════════════
  // STACKOVERFLOW (6 tools)
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "stackoverflow_search",
    description: "Search Stack Overflow questions by keyword. Returns titles, scores, views, answers, tags, links.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        sort: { type: "string", enum: ["relevance", "votes", "creation", "activity"], default: "relevance" },
        size: { type: "integer", minimum: 1, maximum: 100, default: 10 },
      },
      required: ["query"],
    },
  },
  {
    name: "stackoverflow_get_question",
    description: "Get a full Stack Overflow question with body, answers, tags, score.",
    inputSchema: {
      type: "object",
      properties: {
        question_id: { type: "integer", description: "Question ID (e.g. 11227809)" },
      },
      required: ["question_id"],
    },
  },
  {
    name: "stackoverflow_get_answers",
    description: "Get all answers for a Stack Overflow question, sorted by votes.",
    inputSchema: {
      type: "object",
      properties: {
        question_id: { type: "integer", description: "Question ID" },
        size: { type: "integer", minimum: 1, maximum: 100, default: 10 },
      },
      required: ["question_id"],
    },
  },
  {
    name: "stackoverflow_search_by_tag",
    description: "Search questions filtered by tag(s).",
    inputSchema: {
      type: "object",
      properties: {
        tag: { type: "string", description: "Single tag (e.g. 'javascript')" },
        tags: { type: "array", items: { type: "string" }, description: "Multiple tags" },
        sort: { type: "string", enum: ["votes", "creation", "activity", "unanswered"], default: "votes" },
        size: { type: "integer", minimum: 1, maximum: 100, default: 10 },
      },
      required: [],
    },
  },
  {
    name: "stackoverflow_get_tag_info",
    description: "Get info about a Stack Overflow tag (count, synonyms, wiki).",
    inputSchema: {
      type: "object",
      properties: { tag_name: { type: "string", description: "Tag name" } },
      required: ["tag_name"],
    },
  },
  {
    name: "stackoverflow_get_trending",
    description: "Get trending/popular questions on Stack Overflow.",
    inputSchema: {
      type: "object",
      properties: {
        size: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // WEATHER — Open-Meteo (Free, No API Key) (5 tools)
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "weather_current",
    description: "Get current weather for a location (temp, humidity, wind, conditions).",
    inputSchema: {
      type: "object",
      properties: {
        latitude: { type: "number" },
        longitude: { type: "number" },
        city: { type: "string", description: "City name (auto-geocoded)" },
      },
    },
  },
  {
    name: "weather_forecast",
    description: "Get weather forecast up to 16 days (daily or hourly).",
    inputSchema: {
      type: "object",
      properties: {
        latitude: { type: "number" },
        longitude: { type: "number" },
        city: { type: "string" },
        days: { type: "integer", minimum: 1, maximum: 16, default: 7 },
      },
    },
  },
  {
    name: "weather_alerts",
    description: "Get severe weather alerts for a location.",
    inputSchema: {
      type: "object",
      properties: { latitude: { type: "number" }, longitude: { type: "number" } },
      required: ["latitude", "longitude"],
    },
  },
  {
    name: "weather_historical",
    description: "Get historical weather data for a date range (past data).",
    inputSchema: {
      type: "object",
      properties: {
        latitude: { type: "number" },
        longitude: { type: "number" },
        start_date: { type: "string", description: "YYYY-MM-DD" },
        end_date: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["latitude", "longitude", "start_date", "end_date"],
    },
  },
  {
    name: "weather_geocode",
    description: "Convert city name to coordinates.",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string" },
        count: { type: "integer", minimum: 1, maximum: 10, default: 1 },
      },
      required: ["city"],
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // WIKIPEDIA (7 tools)
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "wikipedia_search",
    description: "Search Wikipedia articles by keyword.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        language: { type: "string", default: "en" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
      required: ["query"],
    },
  },
  {
    name: "wikipedia_get_summary",
    description: "Get a quick summary of a Wikipedia article.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        language: { type: "string", default: "en" },
      },
      required: ["title"],
    },
  },
  {
    name: "wikipedia_get_article",
    description: "Get full content of a Wikipedia article as plain text.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        language: { type: "string", default: "en" },
      },
      required: ["title"],
    },
  },
  {
    name: "wikipedia_get_sections",
    description: "Get section structure of a Wikipedia article.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, language: { type: "string", default: "en" } },
      required: ["title"],
    },
  },
  {
    name: "wikipedia_get_links",
    description: "Get internal links from a Wikipedia article.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        language: { type: "string", default: "en" },
        limit: { type: "integer", default: 50 },
      },
      required: ["title"],
    },
  },
  {
    name: "wikipedia_get_random",
    description: "Get a random Wikipedia article.",
    inputSchema: { type: "object", properties: { language: { type: "string", default: "en" } } },
  },
  {
    name: "wikipedia_get_categories",
    description: "Get categories of a Wikipedia article.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, language: { type: "string", default: "en" } },
      required: ["title"],
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // REST COUNTRIES (3 tools) — No API Key
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "country_search",
    description: "Search countries by name. Returns flag, capital, currency, population, languages, timezones.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Country name (e.g. 'Bangladesh')" } },
      required: ["name"],
    },
  },
  {
    name: "country_get_by_code",
    description: "Get country info by 2-letter code (e.g. BD, US, GB).",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string", description: "ISO 3166-1 alpha-2 code" } },
      required: ["code"],
    },
  },
  {
    name: "country_list_all",
    description: "List all countries with basic info (name, code, capital, region).",
    inputSchema: {
      type: "object",
      properties: {
        region: { type: "string", description: "Filter by region: Africa, Americas, Asia, Europe, Oceania" },
        limit: { type: "integer", default: 50 },
      },
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // CURRENCY — FrankFurter (ECB data, No API Key) (3 tools)
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "currency_convert",
    description: "Convert amount from one currency to another using ECB rates.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Source currency (e.g. USD)" },
        to: { type: "string", description: "Target currency (e.g. BDT)" },
        amount: { type: "number", default: 1 },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "currency_rates",
    description: "Get exchange rates for a base currency.",
    inputSchema: {
      type: "object",
      properties: {
        base: { type: "string", default: "USD", description: "Base currency" },
        symbols: { type: "array", items: { type: "string" }, description: "Target currencies (e.g. ['EUR','GBP'])" },
      },
    },
  },
  {
    name: "currency_list",
    description: "List all supported currencies.",
    inputSchema: { type: "object", properties: {} },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // CRYPTO — CoinGecko (Free tier) (3 tools)
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "crypto_price",
    description: "Get live price of cryptocurrencies (BTC, ETH, etc.) in multiple currencies.",
    inputSchema: {
      type: "object",
      properties: {
        coins: { type: "array", items: { type: "string" }, description: "Coin IDs (e.g. ['bitcoin','ethereum'])" },
        currencies: { type: "array", items: { type: "string" }, default: ["usd"], description: "Fiat currencies" },
      },
      required: ["coins"],
    },
  },
  {
    name: "crypto_search",
    description: "Search for a cryptocurrency by name or symbol.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    },
  },
  {
    name: "crypto_market",
    description: "Get top cryptocurrencies by market cap.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
        currency: { type: "string", default: "usd" },
      },
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // IP GEOLOCATION — IP-API (Free, No API Key) (1 tool)
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "ip_lookup",
    description: "Get geolocation info from IP address (country, city, ISP, coordinates).",
    inputSchema: {
      type: "object",
      properties: {
        ip: { type: "string", description: "IP address (empty = your IP)" },
      },
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // QR CODE — qr-server (Free, No API Key) (1 tool)
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "qr_generate",
    description: "Generate a QR code image URL from text or URL.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text or URL to encode" },
        size: { type: "integer", default: 300, description: "Image size in pixels" },
        format: { type: "string", enum: ["png", "svg", "gif"], default: "png" },
      },
      required: ["text"],
    },
  },
];

// ─── Tool Execution Router ─────────────────────────────────────────────────
async function executeTool(name, args) {
  try {
    let result;

    switch (name) {
    // ═══════════════════ STACKOVERFLOW ═══════════════════
    case "stackoverflow_search": {
      const { query, sort, size } = args;
      const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=${sort || "relevance"}&q=${encodeURIComponent(query)}&site=stackoverflow&filter=withbody&pagesize=${size || 10}`;
      const data = await fetchJSON(url);
      result = {
        total: data.total,
        items: (data.items || []).map(q => ({
          id: q.question_id, title: q.title, score: q.score,
          views: q.view_count, answers: q.answer_count, tags: q.tags,
          link: q.link, created: new Date(q.creation_date * 1000).toISOString(),
        })),
      };
      break;
    }

    case "stackoverflow_get_question": {
      const { question_id } = args;
      const url = `https://api.stackexchange.com/2.3/questions/${question_id}?site=stackoverflow&filter=withbody`;
      const data = await fetchJSON(url);
      const q = data.items?.[0];
      if (!q) throw new Error(`Question ${question_id} not found`);
      result = {
        id: q.question_id, title: q.title, body: q.body?.substring(0, 5000),
        score: q.score, views: q.view_count, answers: q.answer_count,
        tags: q.tags, link: q.link, owner: q.owner?.display_name,
        created: new Date(q.creation_date * 1000).toISOString(),
      };
      break;
    }

    case "stackoverflow_get_answers": {
      const { question_id, size } = args;
      const url = `https://api.stackexchange.com/2.3/questions/${question_id}/answers?order=desc&sort=votes&site=stackoverflow&filter=withbody&pagesize=${size || 10}`;
      const data = await fetchJSON(url);
      result = {
        question_id,
        items: (data.items || []).map(a => ({
          id: a.answer_id, body: a.body?.substring(0, 5000),
          score: a.score, is_accepted: a.is_accepted,
          owner: a.owner?.display_name,
          created: new Date(a.creation_date * 1000).toISOString(),
        })),
      };
      break;
    }

    case "stackoverflow_search_by_tag": {
      // Accept both `tag` (string) and `tags` (array)
      let tagList = [];
      if (args.tag) tagList = [args.tag];
      if (args.tags && Array.isArray(args.tags)) tagList = args.tags;
      if (args.tags && typeof args.tags === "string") tagList = [args.tags];
      if (tagList.length === 0) throw new Error("Provide 'tag' or 'tags' parameter");

      const tagged = tagList.join(";");
      const url = `https://api.stackexchange.com/2.3/questions?order=desc&sort=${args.sort || "votes"}&tagged=${encodeURIComponent(tagged)}&site=stackoverflow&filter=withbody&pagesize=${args.size || 10}`;
      const data = await fetchJSON(url);
      result = {
        tags: tagList,
        items: (data.items || []).map(q => ({
          id: q.question_id, title: q.title, score: q.score,
          views: q.view_count, answers: q.answer_count, tags: q.tags,
          link: q.link,
        })),
      };
      break;
    }

    case "stackoverflow_get_tag_info": {
      const { tag_name } = args;
      const url = `https://api.stackexchange.com/2.3/tags/${encodeURIComponent(tag_name)}/info?site=stackoverflow`;
      const data = await fetchJSON(url);
      const tag = data.items?.[0];
      if (!tag) throw new Error(`Tag "${tag_name}" not found`);
      result = { name: tag.name, count: tag.count, has_synonyms: tag.has_synonyms };
      break;
    }

    case "stackoverflow_get_trending": {
      const { size } = args;
      const url = `https://api.stackexchange.com/2.3/questions?order=desc&sort=hot&site=stackoverflow&filter=withbody&pagesize=${size || 10}`;
      const data = await fetchJSON(url);
      result = {
        items: (data.items || []).map(q => ({
          id: q.question_id, title: q.title, score: q.score,
          views: q.view_count, answers: q.answer_count, tags: q.tags,
          link: q.link,
        })),
      };
      break;
    }

    // ═══════════════════ WEATHER ═══════════════════
    case "weather_current": {
      let { latitude: lat, longitude: lon, city } = args;
      if (city && (!lat || !lon)) {
        const geo = await fetchJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`);
        if (!geo.results?.length) throw new Error(`City not found: ${city}`);
        lat = geo.results[0].latitude;
        lon = geo.results[0].longitude;
      }
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m`;
      const data = await fetchJSON(url);
      result = {
        location: { latitude: lat, longitude: lon },
        current: {
          temperature: data.current?.temperature_2m,
          feels_like: data.current?.apparent_temperature,
          humidity: data.current?.relative_humidity_2m,
          precipitation: data.current?.precipitation,
          weather: weatherCodeToDescription(data.current?.weather_code),
          wind_speed: data.current?.wind_speed_10m,
          wind_direction: data.current?.wind_direction_10m,
        },
      };
      break;
    }

    case "weather_forecast": {
      let { latitude: lat, longitude: lon, city, days } = args;
      if (city && (!lat || !lon)) {
        const geo = await fetchJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`);
        if (!geo.results?.length) throw new Error(`City not found: ${city}`);
        lat = geo.results[0].latitude;
        lon = geo.results[0].longitude;
      }
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max&forecast_days=${days || 7}`;
      const data = await fetchJSON(url);
      result = {
        location: { latitude: lat, longitude: lon },
        daily: data.daily?.time?.map((date, i) => ({
          date, weather: weatherCodeToDescription(data.daily?.weather_code?.[i]),
          temp_max: data.daily?.temperature_2m_max?.[i],
          temp_min: data.daily?.temperature_2m_min?.[i],
          precipitation: data.daily?.precipitation_sum?.[i],
          precip_probability: data.daily?.precipitation_probability_max?.[i],
          wind_max: data.daily?.wind_speed_10m_max?.[i],
        })),
      };
      break;
    }

    case "weather_alerts": {
      const { latitude, longitude } = args;
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max&forecast_days=3`;
      const data = await fetchJSON(url);
      const alerts = [];
      const d = data.daily;
      for (let i = 0; i < (d?.time?.length || 0); i++) {
        const code = d.weather_code?.[i];
        const tMax = d.temperature_2m_max?.[i];
        const wind = d.wind_speed_10m_max?.[i];
        const precip = d.precipitation_sum?.[i];
        if (code >= 95) alerts.push({ date: d.time[i], type: "Thunderstorm", severity: "high" });
        if (code >= 75) alerts.push({ date: d.time[i], type: "Heavy Snow", severity: "high" });
        if (code >= 65) alerts.push({ date: d.time[i], type: "Heavy Rain", severity: "medium" });
        if (tMax > 40) alerts.push({ date: d.time[i], type: "Extreme Heat", severity: "medium", value: `${tMax}°C` });
        if (tMax < -10) alerts.push({ date: d.time[i], type: "Extreme Cold", severity: "medium", value: `${tMax}°C` });
        if (wind > 60) alerts.push({ date: d.time[i], type: "Strong Wind", severity: "medium", value: `${wind} km/h` });
        if (precip > 50) alerts.push({ date: d.time[i], type: "Heavy Precipitation", severity: "low", value: `${precip}mm` });
      }
      result = { location: { latitude, longitude }, alerts: alerts.length ? alerts : ["No severe weather alerts"] };
      break;
    }

    case "weather_historical": {
      const { latitude, longitude, start_date, end_date } = args;
      // Validate dates are in the past
      const start = new Date(start_date);
      const end = new Date(end_date);
      const now = new Date();
      if (start >= now) throw new Error("start_date must be in the past");
      if (end >= now) throw new Error("end_date must be in the past");
      if (start > end) throw new Error("start_date must be before end_date");

      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${latitude}&longitude=${longitude}&start_date=${start_date}&end_date=${end_date}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,weather_code`;
      const data = await fetchJSON(url);
      result = {
        location: { latitude, longitude },
        period: { start: start_date, end: end_date },
        daily: data.daily?.time?.map((date, i) => ({
          date, weather: weatherCodeToDescription(data.daily?.weather_code?.[i]),
          temp_max: data.daily?.temperature_2m_max?.[i],
          temp_min: data.daily?.temperature_2m_min?.[i],
          precipitation: data.daily?.precipitation_sum?.[i],
          wind_max: data.daily?.wind_speed_10m_max?.[i],
        })),
      };
      break;
    }

    case "weather_geocode": {
      const { city, count } = args;
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=${count || 1}`;
      const data = await fetchJSON(url);
      result = {
        query: city,
        results: (data.results || []).map(r => ({
          name: r.name, country: r.country, admin1: r.admin1,
          latitude: r.latitude, longitude: r.longitude, timezone: r.timezone,
        })),
      };
      break;
    }

    // ═══════════════════ WIKIPEDIA ═══════════════════
    case "wikipedia_search": {
      const { query, language, limit } = args;
      const lang = language || "en";
      const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit || 10}&format=json`;
      const data = await fetchJSON(url);
      result = {
        query, total: data.query?.searchinfo?.totalhits || 0,
        items: (data.query?.search || []).map(s => ({
          title: s.title, snippet: s.snippet?.replace(/<[^>]*>/g, ""),
          url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(s.title)}`,
        })),
      };
      break;
    }

    case "wikipedia_get_summary": {
      const { title, language } = args;
      const lang = language || "en";
      const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
      const data = await fetchJSON(url);
      result = {
        title: data.title, description: data.description,
        extract: data.extract, thumbnail: data.thumbnail?.source,
        url: data.content_urls?.desktop?.page,
      };
      break;
    }

    case "wikipedia_get_article": {
      const { title, language } = args;
      const lang = language || "en";
      // Use action=parse for full article content
      const url = `https://${lang}.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&format=json&redirects=1`;
      const data = await fetchJSON(url);
      if (data.error) throw new Error(data.error.info || "Article not found");
      // Clean wikitext to readable text
      let content = data.parse?.wikitext?.wikitext || "";
      // Remove common wikitext markup
      content = content.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2"); // links
      content = content.replace(/'''?/g, ""); // bold/italic
      content = content.replace(/<[^>]*>/g, ""); // HTML tags
      content = content.replace(/\{\{[^}]*\}\}/g, ""); // templates
      content = content.replace(/\n{3,}/g, "\n\n"); // extra newlines
      result = {
        title: data.parse?.title || title,
        content: content.substring(0, 50000),
        url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(data.parse?.title || title)}`,
      };
      break;
    }

    case "wikipedia_get_sections": {
      const { title, language } = args;
      const lang = language || "en";
      const url = `https://${lang}.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(title)}&prop=sections&format=json`;
      const data = await fetchJSON(url);
      result = {
        title,
        sections: (data.parse?.sections || []).map(s => ({
          index: s.index, level: s.level, title: s.line, anchor: s.anchor,
        })),
      };
      break;
    }

    case "wikipedia_get_links": {
      const { title, language, limit } = args;
      const lang = language || "en";
      const url = `https://${lang}.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=links&pllimit=${limit || 50}&format=json`;
      const data = await fetchJSON(url);
      const pages = data.query?.pages || {};
      const pageId = Object.keys(pages)[0];
      result = {
        title,
        links: (pages[pageId]?.links || []).map(l => ({
          title: l.title,
          url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(l.title)}`,
        })),
      };
      break;
    }

    case "wikipedia_get_random": {
      const { language } = args;
      const lang = language || "en";
      const url = `https://${lang}.wikipedia.org/api/rest_v1/page/random/summary`;
      const data = await fetchJSON(url);
      result = {
        title: data.title, description: data.description,
        extract: data.extract, thumbnail: data.thumbnail?.source,
        url: data.content_urls?.desktop?.page,
      };
      break;
    }

    case "wikipedia_get_categories": {
      const { title, language } = args;
      const lang = language || "en";
      const url = `https://${lang}.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=categories&cllimit=50&format=json`;
      const data = await fetchJSON(url);
      const pages = data.query?.pages || {};
      const pageId = Object.keys(pages)[0];
      result = {
        title,
        categories: (pages[pageId]?.categories || []).map(c => c.title.replace("Category:", "")),
      };
      break;
    }

    // ═══════════════════ REST COUNTRIES ═══════════════════
    case "country_search": {
      const { name } = args;
      const url = `https://restcountries.com/v3.1/name/${encodeURIComponent(name)}?fields=name,capital,region,subregion,population,flags,currencies,languages,timezones,area,cca2`;
      const data = await fetchJSON(url);
      result = (Array.isArray(data) ? data : [data]).map(c => ({
        name: c.name?.common, official: c.name?.official,
        capital: c.capital, region: c.region, subregion: c.subregion,
        population: c.population, area: c.area,
        flag: c.flags?.png || c.flags?.svg,
        currencies: c.currencies ? Object.entries(c.currencies).map(([k, v]) => ({ code: k, name: v.name, symbol: v.symbol })) : [],
        languages: c.languages ? Object.values(c.languages) : [],
        timezones: c.timezones, code: c.cca2,
      }));
      break;
    }

    case "country_get_by_code": {
      const { code } = args;
      const url = `https://restcountries.com/v3.1/alpha/${encodeURIComponent(code)}?fields=name,capital,region,subregion,population,flags,currencies,languages,timezones,area,cca2,cca3,borders`;
      const data = await fetchJSON(url);
      const c = Array.isArray(data) ? data[0] : data;
      result = {
        name: c.name?.common, official: c.name?.official,
        capital: c.capital, region: c.region, subregion: c.subregion,
        population: c.population, area: c.area,
        flag: c.flags?.png || c.flags?.svg,
        currencies: c.currencies ? Object.entries(c.currencies).map(([k, v]) => ({ code: k, name: v.name, symbol: v.symbol })) : [],
        languages: c.languages ? Object.values(c.languages) : [],
        timezones: c.timezones, code: c.cca2, code3: c.cca3,
        borders: c.borders,
      };
      break;
    }

    case "country_list_all": {
      const { region, limit } = args;
      let url = `https://restcountries.com/v3.1/all?fields=name,region,capital,cca2`;
      if (region) url += `&region=${encodeURIComponent(region)}`;
      const data = await fetchJSON(url);
      const sorted = (Array.isArray(data) ? data : [data]).sort((a, b) => (a.name?.common || "").localeCompare(b.name?.common || ""));
      result = {
        count: sorted.length,
        countries: sorted.slice(0, limit || 50).map(c => ({
          name: c.name?.common, code: c.cca2, capital: c.capital?.[0], region: c.region,
        })),
      };
      break;
    }

    // ═══════════════════ CURRENCY ═══════════════════
    case "currency_convert": {
      const { from, to, amount } = args;
      const fromUp = from.toUpperCase();
      const toUp = to.toUpperCase();
      // First check if both currencies are supported
      const listData = await fetchJSON("https://api.frankfurter.dev/v1/currencies");
      const supported = Object.keys(listData);
      if (!supported.includes(fromUp)) throw new Error(`Currency "${fromUp}" not supported. Use currency_list to see options.`);
      if (!supported.includes(toUp)) throw new Error(`Currency "${toUp}" not supported. Use currency_list to see options.`);
      const url = `https://api.frankfurter.dev/v1/latest?base=${fromUp}&symbols=${toUp}`;
      const data = await fetchJSON(url);
      const rate = data.rates?.[toUp];
      result = {
        from: fromUp, to: toUp, amount: amount || 1, rate,
        result: (amount || 1) * rate, date: data.date,
      };
      break;
    }

    case "currency_rates": {
      const { base, symbols } = args;
      let url = `https://api.frankfurter.dev/v1/latest?base=${(base || "USD").toUpperCase()}`;
      if (symbols?.length) url += `&symbols=${symbols.map(s => s.toUpperCase()).join(",")}`;
      const data = await fetchJSON(url);
      result = { base: data.base, date: data.date, rates: data.rates };
      break;
    }

    case "currency_list": {
      const data = await fetchJSON("https://api.frankfurter.dev/v1/currencies");
      result = Object.entries(data).map(([code, info]) => ({ code, name: info.name, symbol: info.symbol }));
      break;
    }

    // ═══════════════════ CRYPTO ═══════════════════
    case "crypto_price": {
      const { coins, currencies } = args;
      const ids = (coins || ["bitcoin"]).join(",");
      const vs = (currencies || ["usd"]).join(",");
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=${vs}&include_24hr_change=true&include_market_cap=true`;
      const data = await fetchJSON(url);
      result = Object.entries(data).map(([coin, info]) => ({
        coin, prices: info,
      }));
      break;
    }

    case "crypto_search": {
      const { query } = args;
      const url = `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`;
      const data = await fetchJSON(url);
      result = {
        total: data.coins?.length || 0,
        coins: (data.coins || []).slice(0, 10).map(c => ({
          id: c.id, name: c.name, symbol: c.symbol,
          market_cap_rank: c.market_cap_rank, thumb: c.thumb,
        })),
      };
      break;
    }

    case "crypto_market": {
      const { limit, currency } = args;
      const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=${currency || "usd"}&order=market_cap_desc&per_page=${limit || 10}&page=1&sparkline=false`;
      const data = await fetchJSON(url);
      result = data.map(c => ({
        id: c.id, name: c.name, symbol: c.symbol,
        price: c.current_price, market_cap: c.market_cap,
        change_24h: c.price_change_percentage_24h,
        rank: c.market_cap_rank,
      }));
      break;
    }

    // ═══════════════════ IP GEOLOCATION ═══════════════════
    case "ip_lookup": {
      const { ip } = args;
      const url = ip ? `http://ip-api.com/json/${ip}` : "http://ip-api.com/json/";
      const data = await fetchJSON(url);
      if (data.status === "fail") throw new Error(data.message || "IP lookup failed");
      result = {
        ip: data.query, country: data.country, country_code: data.countryCode,
        region: data.regionName, city: data.city, zip: data.zip,
        lat: data.lat, lon: data.lon, timezone: data.timezone,
        isp: data.isp, org: data.org, as: data.as,
      };
      break;
    }

    // ═══════════════════ QR CODE ═══════════════════
    case "qr_generate": {
      const { text, size, format } = args;
      const s = size || 300;
      const f = format || "png";
      result = {
        text,
        url: `https://api.qrserver.com/v1/create-qr-code/?size=${s}x${s}&data=${encodeURIComponent(text)}&format=${f}`,
        size: s, format: f,
      };
      break;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error executing ${name}: ${error.message}` }],
      isError: true,
    };
  }
}

// ─── JSON-RPC 2.0 Handler ──────────────────────────────────────────────────
function handleJSONRPC(body) {
  const { id, method, params } = body;
  if (id === undefined || id === null) return null;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0", id,
        result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
      };
    case "notifications/initialized": return null;
    case "ping": return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return {
        jsonrpc: "2.0", id,
        result: { tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) },
      };
    case "tools/call": {
      const { name, arguments: args } = params || {};
      return executeTool(name, args || {}).then(result => ({ jsonrpc: "2.0", id, result }));
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// ─── HTTP Server ───────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", server: SERVER_INFO.name, version: SERVER_INFO.version, tools: TOOLS.length }));
    return;
  }

  if (req.method === "POST" && req.url === "/mcp") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const parsed = JSON.parse(body);
      const response = await handleJSONRPC(parsed);
      if (response === null) { res.writeHead(204); res.end(); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } catch (error) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found. Use POST /mcp for MCP protocol." }));
});

// Loopback-only bind: unauthenticated local tool backend — main server talks
// to it on the same machine, so it must never be exposed on the network.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[Public API MCP v2.0] http://127.0.0.1:${PORT}/mcp`);
  console.log(`[Tools] ${TOOLS.length} registered`);
  console.log(`[APIs] StackOverflow, Weather, Wikipedia, Countries, Currency, Crypto, IP, QR`);
});
