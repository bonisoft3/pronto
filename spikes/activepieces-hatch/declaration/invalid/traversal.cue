package declaration

example: #Declaration & {
 hatches: integrations: {
  kind: "container"
  note: "Trusted integration code can reach its configured provider."
  activepieces: {
   pieces: mail: {local: "./pieces/../secrets", export: "mail"}
   actions: sendMail: {
    piece: "mail"
    action: "send-mail"
    inputSchema: "./pieces/mail/send.input.schema.json"
    outputSchema: "./pieces/mail/send.output.schema.json"
    idempotencyKeyProp: "requestKey"
    auth: {jsonSecret: "SMTP_AUTH_JSON", schema: "./pieces/mail/mail.auth.schema.json"}
    fixedProps: {host: "smtp.example.test", port: 587}
   }
  }
 }
 bridges: mail: {container: "integrations", action: "sendMail"}
 effects: notify: {
  sink: {bridge: "mail", idempotent: false}
  reentry: "unknown"
  note: "A lost response may follow delivery."
 }
}
