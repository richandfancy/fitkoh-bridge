import type {
  PosterClient as PosterClientType,
  PosterTransaction,
  PosterTransactionHistoryEntry,
} from '@shared/types'

export class PosterClient {
  private token: string
  private baseUrl = 'https://joinposter.com/api/'

  constructor(token: string) {
    this.token = token
  }

  private async request<T>(
    method: string,
    params?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${method}`)
    url.searchParams.set('token', this.token)
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v)
      }
    }
    const resp = await fetch(url.toString())
    if (!resp.ok) throw new Error(`Poster API error: ${resp.status}`)
    const data = (await resp.json()) as { response: T }
    return data.response
  }

  async getClients(params?: {
    phone?: string
    num?: number
  }): Promise<PosterClientType[]> {
    return this.request('clients.getClients', {
      ...(params?.phone && { phone: params.phone }),
      ...(params?.num && { num: String(params.num) }),
    })
  }

  async getClient(clientId: number): Promise<PosterClientType[]> {
    return this.request('clients.getClient', {
      client_id: String(clientId),
    })
  }

  async createClient(data: {
    client_name: string
    client_groups_id_client: number
    phone?: string
    email?: string
    comment?: string
  }): Promise<number> {
    const url = new URL(`${this.baseUrl}clients.createClient`)
    url.searchParams.set('token', this.token)
    const formData = new URLSearchParams()
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined) formData.set(k, String(v))
    }
    const resp = await fetch(url.toString(), {
      method: 'POST',
      body: formData,
    })
    if (!resp.ok) throw new Error(`Poster createClient error: ${resp.status}`)
    const result = (await resp.json()) as { response: number }
    return result.response
  }

  async getTransactions(
    dateFrom: string,
    dateTo: string,
    params?: Record<string, string>,
  ): Promise<PosterTransaction[]> {
    return this.request('dash.getTransactions', {
      dateFrom,
      dateTo,
      ...params,
    })
  }

  async getTransaction(
    transactionId: string,
    includeProducts = true,
  ): Promise<PosterTransaction[]> {
    return this.request('dash.getTransaction', {
      transaction_id: transactionId,
      ...(includeProducts && { include_products: 'true' }),
    })
  }

  async getTransactionHistory(
    transactionId: string,
  ): Promise<PosterTransactionHistoryEntry[]> {
    return this.request('dash.getTransactionHistory', {
      transaction_id: transactionId,
    })
  }

  async getProducts(): Promise<
    Array<{
      product_id: string
      product_name: string
      category_name: string
      price: Record<string, string> | string
    }>
  > {
    return this.request('menu.getProducts')
  }

  // For pre-invoice: get all transactions for a specific client in a date range
  async getClientTransactions(
    clientId: number,
    dateFrom: string,
    dateTo: string,
  ): Promise<PosterTransaction[]> {
    const allTxns = await this.getTransactions(dateFrom, dateTo)
    return allTxns.filter((t) => t.client_id === String(clientId))
  }
}
