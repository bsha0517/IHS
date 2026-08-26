import { BookingWizard } from "@/app/book/booking-wizard"

export default function PublicBookingPage() {
  return (
    <div className="flex min-h-svh items-center justify-center bg-muted/30 p-4">
      <div className="flex w-full max-w-lg flex-col items-center gap-4">
        <h1 className="text-xl font-semibold">Book an Appointment</h1>
        <BookingWizard />
      </div>
    </div>
  )
}
