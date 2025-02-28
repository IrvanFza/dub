import { DubApiError } from "@/lib/api/errors";
import { createPartnerLink } from "@/lib/api/partners/create-partner-link";
import { enrollPartner } from "@/lib/api/partners/enroll-partner";
import { parseRequestBody } from "@/lib/api/utils";
import { withWorkspace } from "@/lib/auth";
import { embedToken } from "@/lib/embed/embed-token";
import {
  createEmbedTokenSchema,
  EmbedTokenSchema,
} from "@/lib/zod/schemas/token";
import { prisma } from "@dub/prisma";
import { ProgramEnrollment } from "@prisma/client";
import { NextResponse } from "next/server";

// POST /api/tokens/embed - create a new embed token for the given partner/tenant
export const POST = withWorkspace(
  async ({ workspace, req, session }) => {
    const {
      programId,
      partnerId,
      tenantId,
      partner: partnerProps,
    } = createEmbedTokenSchema.parse(await parseRequestBody(req));

    if (!partnerId && !tenantId && !partnerProps) {
      throw new DubApiError({
        message: "You must provide either partnerId, tenantId, or partner.",
        code: "bad_request",
      });
    }

    let programEnrollment: Pick<ProgramEnrollment, "partnerId"> | null = null;

    if (partnerId || tenantId) {
      programEnrollment = await prisma.programEnrollment.findUnique({
        where: partnerId
          ? { partnerId_programId: { partnerId, programId } }
          : { tenantId_programId: { tenantId: tenantId!, programId } },
        select: {
          partnerId: true,
        },
      });
    } else if (partnerProps) {
      const program = await prisma.program.findUnique({
        where: {
          id: programId,
        },
        select: {
          id: true,
          workspaceId: true,
          defaultFolderId: true,
          domain: true,
          url: true,
        },
      });

      if (!program || program.workspaceId !== workspace.id) {
        throw new DubApiError({
          message: `Program with ID ${programId} not found.`,
          code: "not_found",
        });
      }

      const partner = await prisma.partner.findUnique({
        where: {
          email: partnerProps.email,
        },
        include: {
          programs: {
            where: {
              programId,
            },
          },
        },
      });

      // Partner does not exist, we need to create them
      if (!partner) {
        const partnerLink = await createPartnerLink({
          workspace,
          program,
          partner: {
            ...partnerProps,
            programId,
          },
          userId: session.user.id,
        });

        const enrolledPartner = await enrollPartner({
          workspace,
          program,
          partner: partnerProps,
          link: partnerLink,
          skipPartnerCheck: true,
        });

        programEnrollment = {
          partnerId: enrolledPartner.id,
        };
      }
      // Partner exists but is not enrolled in the program, we need to enroll them
      else if (partner.programs.length === 0) {
        //
      }
    }

    if (!programEnrollment) {
      // TODO:
      // Fix this partnerId not always being set

      throw new DubApiError({
        message: `Partner with ID ${partnerId} is not enrolled in this program (${programId}).`,
        code: "not_found",
      });
    }

    const response = await embedToken.create({
      programId,
      partnerId: programEnrollment.partnerId,
    });

    return NextResponse.json(EmbedTokenSchema.parse(response), {
      status: 201,
    });
  },
  {
    requiredPermissions: ["links.write"],
    requiredPlan: [
      "business",
      "business plus",
      "business extra",
      "business max",
      "enterprise",
    ],
  },
);

