import { paymentProgram } from "./effects-fixtures.ts";

// A company shared with two groups, a composition and a grant table under
// it, and an advance its requester owns, shares with one user or one group
// by a grant row, and with the finance group of its company. A company's
// writers share it; an advance keeps its grants to its owner.
export const driveEntities = `
      GroupMember: {
        table: "group_member"
        durability: "server"
        access: {scope: "group", group: "group_id", user: "user_id"}
        fields: [{name: "id", type: "uuid", pk: true}, {name: "group_id", type: "string"}, {name: "user_id", type: "uuid"}]
      }
      Company: {
        table: "company"
        durability: "server"
        access: {scope: "private", owner: "owner_id", shared: {via: "company_grant", on: "company_id", user: "user_id", role: "role"},
          groups: [{group: "everyone", role: "reader"}, {group: "admins", role: "writer"}]}
        fields: [{name: "id", type: "uuid", pk: true}, {name: "owner_id", type: "uuid"}, {name: "name", type: "string"}]
      }
      CompanyGrant: {
        table: "company_grant"
        durability: "server"
        access: {scope: "folder", parent: "Company", on: "company_id"}
        fields: [{name: "id", type: "uuid", pk: true}, {name: "company_id", type: "uuid", ref: "company"}, {name: "user_id", type: "uuid"}, {name: "role", type: "string"}]
      }
      ExpenseType: {
        table: "expense_type"
        durability: "server"
        access: {scope: "folder", parent: "Company", on: "company_id"}
        fields: [{name: "id", type: "uuid", pk: true}, {name: "company_id", type: "uuid", ref: "company"}, {name: "label", type: "string"}]
      }
      Advance: {
        table: "advance"
        durability: "server"
        access: {scope: "private", owner: "owner_id", shared: {via: "advance_grant", on: "advance_id", user: "user_id", group: "group_id", role: "role", writersCanShare: false},
          groups: [{group: "finance", of: "company_id", role: "reader"}]}
        fields: [{name: "id", type: "uuid", pk: true}, {name: "owner_id", type: "uuid"}, {name: "company_id", type: "uuid", ref: "company"}, {name: "amount", type: "int32"}]
      }
      AdvanceGrant: {
        table: "advance_grant"
        durability: "server"
        access: {scope: "folder", parent: "Advance", on: "advance_id"}
        fields: [{name: "id", type: "uuid", pk: true}, {name: "advance_id", type: "uuid", ref: "advance"}, {name: "user_id", type: "uuid", required: false}, {name: "group_id", type: "string", required: false}, {name: "role", type: "string"}]
      }`;


/** The program, with or without its membership list. */
export const driveProgram = (entity = driveEntities) =>
  paymentProgram({ entity }).replace(`{name: "total", type: "decimal", precision: 12, scale: 2}`, `{name: "total", type: "int32"}`);
