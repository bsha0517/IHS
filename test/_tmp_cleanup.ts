import "dotenv/config"
import "../test/setup-test-database"
import { db } from "@/lib/db"
async function main() {
  const patients = await db.patient.findMany({ where: { mrn: { startsWith: "TESTP35-" } }, select: { id: true } })
  const patientIds = patients.map((p) => p.id)
  console.log("orphaned P3.5 patients:", patientIds.length)
  if (patientIds.length === 0) { await db.$disconnect(); return }

  const orders = await db.clinicalOrder.findMany({ where: { patientId: { in: patientIds } }, select: { id: true } })
  const orderIds = orders.map((o) => o.id)
  const appts = await db.appointment.findMany({ where: { patientId: { in: patientIds } }, select: { id: true } })
  const apptIds = appts.map((a) => a.id)
  const encounters = await db.encounter.findMany({ where: { patientId: { in: patientIds } }, select: { id: true } })
  const encounterIds = encounters.map((e) => e.id)

  await db.imagingReportAmendment.deleteMany({ where: { imagingOrder: { clinicalOrderId: { in: orderIds } } } })
  await db.labOrderTest.deleteMany({ where: { clinicalOrderId: { in: orderIds } } })
  await db.specimen.deleteMany({ where: { clinicalOrderId: { in: orderIds } } })
  await db.imagingOrder.deleteMany({ where: { clinicalOrderId: { in: orderIds } } })
  await db.labOrderDetail.deleteMany({ where: { clinicalOrderId: { in: orderIds } } })
  await db.imagingOrderDetail.deleteMany({ where: { clinicalOrderId: { in: orderIds } } })
  await db.charge.deleteMany({ where: { patientId: { in: patientIds } } })
  await db.clinicalOrder.deleteMany({ where: { id: { in: orderIds } } })
  await db.queueEntry.deleteMany({ where: { appointmentId: { in: apptIds } } })
  await db.appointmentStatusHistory.deleteMany({ where: { appointmentId: { in: apptIds } } })
  await db.encounter.deleteMany({ where: { id: { in: encounterIds } } })
  await db.appointment.deleteMany({ where: { id: { in: apptIds } } })
  await db.commMessage.deleteMany({ where: { patientId: { in: patientIds } } })
  await db.patient.deleteMany({ where: { id: { in: patientIds } } })
  console.log(`Cleaned up ${patientIds.length} orphaned P3.5 fixture patients and their chains.`)
  await db.$disconnect()
}
main()
