export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export interface SearchResponse {
  results: SearchResult[]
  query: string
}

export async function searchWeb(
  query: string,
  apiKey: string,
  provider: 'tavily' | 'serper',
  maxResults: number = 5
): Promise<SearchResponse> {
  if (!apiKey) return { results: [], query }
  const n = Math.max(1, Math.min(20, Math.floor(maxResults) || 5))

  if (provider === 'tavily') {
    return searchTavily(query, apiKey, n)
  }
  return searchSerper(query, apiKey, n)
}

async function searchTavily(query: string, apiKey: string, maxResults: number): Promise<SearchResponse> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults })
  })
  if (!res.ok) throw new Error(`Tavily error: ${res.statusText}`)
  const data = await res.json() as { results: Array<{ title: string; url: string; content: string }> }
  return {
    query,
    results: (data.results || []).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.content?.slice(0, 300) || ''
    }))
  }
}

async function searchSerper(query: string, apiKey: string, maxResults: number): Promise<SearchResponse> {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
    body: JSON.stringify({ q: query, num: maxResults })
  })
  if (!res.ok) throw new Error(`Serper error: ${res.statusText}`)
  const data = await res.json() as { organic?: Array<{ title: string; link: string; snippet: string }> }
  return {
    query,
    results: (data.organic || []).map(r => ({
      title: r.title,
      url: r.link,
      snippet: r.snippet || ''
    }))
  }
}
