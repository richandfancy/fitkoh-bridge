import type {
  ClockBooking,
  ClockFolio,
  ClockChargeTemplate,
  ClockCharge,
} from '@shared/types'

export interface ClockClient {
  getBooking(bookingId: string): Promise<ClockBooking>
  getFolio(bookingId: string): Promise<ClockFolio>
  postCharges(
    folioId: string,
    charges: ClockCharge[],
  ): Promise<{ id: number; text: string }[]>
  getChargeTemplates(): Promise<ClockChargeTemplate[]>
}
