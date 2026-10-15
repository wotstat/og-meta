export const database = {
  url: Bun.env.CLICKHOUSE_PROXY_URL ?? 'https://wotstat.info/api/db/',
  username: Bun.env.CLICKHOUSE_USER ?? 'public',
  password: Bun.env.CLICKHOUSE_PASSWORD ?? '',
  request_timeout: 8000,
}
