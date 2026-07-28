UPDATE students SET "applicationTimestamp" = NOW(), "hasSubmitted" = true, "applicationStatus" = 'SUBMITTED' WHERE "hasSubmitted" = false;
