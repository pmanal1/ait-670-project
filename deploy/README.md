# Private SpotMe deployment

The public hostname is `ait670.paulomanalo.dev`. Nginx terminates HTTPS and
requires one Basic Authentication account for every page, JSON file, and API
request. The browser displays a username/password prompt. The account name is
`paulo`; choose a strong, unique password and save it in your password manager.
No application user database is needed for this single-user deployment.

## Install on the homelab

The host must already have Nginx, a valid Let's Encrypt certificate for the
hostname, and the Certbot TLS files referenced in `nginx/spotme.conf`.
On Ubuntu, install `apache2-utils` to get the `htpasswd` utility.

Create the password file interactively, outside the checkout. These commands
do not put the password in shell history or command arguments. `-c` is only
for the first creation; omit it to change an existing password.

```sh
sudo htpasswd -c -B -C 12 /etc/nginx/spotme.htpasswd paulo
sudo chown root:www-data /etc/nginx/spotme.htpasswd
sudo chmod 640 /etc/nginx/spotme.htpasswd
```

Back up the existing enabled site outside `sites-enabled` before replacing
it. Avoid leaving backup files in an included Nginx directory. Install the
checked-in configuration, replacing the old site rather than enabling a
second copy with the same hostname or rate-limit zones:

```sh
sudo cp -L /etc/nginx/sites-enabled/ait670.paulomanalo.dev /root/spotme-nginx-before-auth.conf
sudo install -m 644 deploy/nginx/spotme.conf /etc/nginx/sites-available/ait670.paulomanalo.dev
sudo ln -sfn /etc/nginx/sites-available/ait670.paulomanalo.dev /etc/nginx/sites-enabled/ait670.paulomanalo.dev
sudo nginx -t
sudo systemctl reload nginx
```

Deploy this revision of `server.js` and restart the existing app service:

```sh
systemctl --user restart ait670.service
ss -ltn | grep ':5173'
```

Port 5173 must listen only on `127.0.0.1`, never `0.0.0.0` or `[::]`. Local
processes on the host can reach the trusted upstream directly; do not publish
it through another proxy, tunnel, container mapping, or port forward.

## Protection and limits

- HTTP redirects to the fixed HTTPS hostname without requesting a password.
- HTTPS requires a valid login for all routes and methods. Missing or invalid
  credentials receive `401` before the request reaches Node.
- Each client IP gets an average of 5 requests/second with a burst allowance
  of 20 excess requests. This also slows repeated password guesses.
- After Nginx authenticates a request, the Node process applies one shared
  budget to POST requests dispatched to the four paid AI handlers. It refills
  at 12 requests/minute and allows five immediate requests (one plus four
  excess in a burst). Excess requests receive `429` and `Retry-After` seconds.
  Anonymous requests, incorrect passwords, and non-POST methods cannot use
  this allowance. One prompt may call both classification and another AI
  endpoint. The app uses the same parsed path for limiting and dispatch, so
  backslash variants, dot segments, query strings, and changes of client IP
  cannot bypass the budget. This is a request limit, not a spending cap.
- Browser writes from a different origin are rejected with `403`, because
  browsers may automatically reuse cached Basic credentials. Origin-less
  API clients still need the password.
- Responses use `Cache-Control: no-store`; the login Authorization header is
  removed before proxying to Node.

The limits use Nginx's actual peer address. Do not trust arbitrary
`X-Forwarded-For` headers. If a trusted CDN or another proxy is added later,
configure its real-IP handling explicitly and recheck the client limit.

The AI allowance is held in memory in the single Node process; restarting it
refills the burst. Keep one app process for this deployment. Multiple app
processes would need a shared budget store.

## Verify and change the password

```sh
# Must return 301 and an HTTPS Location, without a Basic challenge.
curl -I http://ait670.paulomanalo.dev/
# Both must return 401 with WWW-Authenticate: Basic.
curl -I https://ait670.paulomanalo.dev/
curl -i https://ait670.paulomanalo.dev/api/sessions
# curl asks privately for the password; these must return 200.
curl -u paulo -i https://ait670.paulomanalo.dev/
curl -u paulo https://ait670.paulomanalo.dev/api/sessions
```

Change the login with `sudo htpasswd -B -C 12 /etc/nginx/spotme.htpasswd paulo`.
Nginx reads the password file on requests; changing it does not require an app
restart. Basic Authentication has no application logout button; browsers may
retain the login until the browser session ends.

Authentication does not rotate previously exposed provider keys. Set a provider
spending cap where supported.

References: [Nginx Basic Authentication](https://nginx.org/en/docs/http/ngx_http_auth_basic_module.html)
and [request limiting](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html).
