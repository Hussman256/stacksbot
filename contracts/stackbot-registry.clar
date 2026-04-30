;; StackBot Registry
;; On-chain registry for StackBot - a Telegram trading bot for the Stacks ecosystem.
;; Tracks registered users and cumulative trade volume routed through the bot.

(define-constant CONTRACT-OWNER tx-sender)
(define-constant ERR-UNAUTHORIZED (err u100))
(define-constant ERR-ALREADY-REGISTERED (err u101))

(define-data-var total-users uint u0)
(define-data-var total-trades uint u0)

(define-map registered-users principal { registered-at-block: uint })

;; Register as a StackBot user on-chain
(define-public (register)
  (if (is-some (map-get? registered-users tx-sender))
    ERR-ALREADY-REGISTERED
    (begin
      (map-set registered-users tx-sender { registered-at-block: block-height })
      (var-set total-users (+ (var-get total-users) u1))
      (ok true))))

;; Record a completed trade - only callable by the contract owner (bot operator)
(define-public (record-trade)
  (if (is-eq tx-sender CONTRACT-OWNER)
    (begin
      (var-set total-trades (+ (var-get total-trades) u1))
      (ok true))
    ERR-UNAUTHORIZED))

;; Read-only: total registered users
(define-read-only (get-total-users)
  (ok (var-get total-users)))

;; Read-only: total trades recorded through the bot
(define-read-only (get-total-trades)
  (ok (var-get total-trades)))

;; Read-only: check if an address is registered
(define-read-only (is-registered (user principal))
  (ok (is-some (map-get? registered-users user))))

;; Read-only: get registration block for an address
(define-read-only (get-registration (user principal))
  (ok (map-get? registered-users user)))
