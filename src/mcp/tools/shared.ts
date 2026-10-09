import { z } from "zod";

export const accountArg = {
  account: z.string().optional().describe("Account id (default: the first configured account)"),
};

export const folderArg = {
  folder: z.string().optional().describe("Folder path (default: the account's first watched folder)"),
};

export const uidArg = {
  uid: z.number().int().positive().describe("Message UID within the folder"),
};

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/, "use YYYY-MM-DD")
  .describe("YYYY-MM-DD");

export const searchShape = {
  from: z.string().optional(),
  to: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  since: date.optional(),
  before: date.optional(),
  unseen: z.boolean().optional(),
  flagged: z.boolean().optional(),
  keyword: z.string().optional().describe("Has this IMAP keyword, e.g. $Forwarded"),
  notKeyword: z.string().optional().describe("Lacks this IMAP keyword"),
};
