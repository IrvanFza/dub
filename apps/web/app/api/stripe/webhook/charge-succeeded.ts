import { stripe } from "@/lib/stripe";
import { sendEmail } from "@dub/email";
import { PartnerPayoutSent } from "@dub/email/templates/partner-payout-sent";
import { prisma } from "@dub/prisma";
import Stripe from "stripe";

export async function chargeSucceeded(event: Stripe.Event) {
  const charge = event.data.object as Stripe.Charge;

  const { id: chargeId, receipt_url, transfer_group } = charge;

  if (!transfer_group) {
    console.log("No transfer group found, skipping...");
    return;
  }

  console.log({ chargeId, receipt_url, transfer_group });

  const invoice = await prisma.invoice.findUnique({
    where: {
      id: transfer_group,
    },
    include: {
      payouts: {
        where: {
          status: {
            not: "completed",
          },
        },
        include: {
          program: true,
          partner: true,
        },
      },
    },
  });

  if (!invoice) {
    console.log(`Invoice with transfer group ${transfer_group} not found.`);
    return;
  }

  if (invoice.status === "completed") {
    console.log("Invoice already completed, skipping...");
    return;
  }

  if (invoice.payouts.length === 0) {
    console.log("No payouts found with status not completed, skipping...");
    return;
  }

  for (const payout of invoice.payouts) {
    const transfer = await stripe.transfers.create({
      amount: payout.amount,
      currency: "usd",
      destination: payout.partner.stripeConnectId!,
      transfer_group: invoice.id,
      ...(!charge.payment_method_details?.ach_credit_transfer
        ? {
            source_transaction: charge.id,
          }
        : {}),
      description: `Dub Partners payout (${payout.program.name})`,
    });

    console.log("Transfer created", transfer);

    await Promise.all([
      prisma.payout.update({
        where: {
          id: payout.id,
        },
        data: {
          stripeTransferId: transfer.id,
          status: "completed",
          paidAt: new Date(),
        },
      }),
      prisma.commission.updateMany({
        where: {
          payoutId: payout.id,
        },
        data: {
          status: "paid",
        },
      }),
      payout.partner.email &&
        sendEmail({
          subject: "You've been paid!",
          email: payout.partner.email,
          from: "Dub Partners <system@dub.co>",
          react: PartnerPayoutSent({
            email: payout.partner.email,
            program: payout.program,
            payout: {
              id: payout.id,
              amount: payout.amount,
              startDate: payout.periodStart,
              endDate: payout.periodEnd,
            },
          }),
          variant: "notifications",
        }),
    ]);
  }

  await prisma.invoice.update({
    where: {
      id: invoice.id,
    },
    data: {
      status: "completed",
      receiptUrl: receipt_url,
      paidAt: new Date(),
    },
  });
}
