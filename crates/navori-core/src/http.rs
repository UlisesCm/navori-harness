//! The injectable HTTP `GET` of the version notices (spec 0060 D42, spec 0062 T9, R85).
//!
//! The TS fetches with `fetch(url, { signal: AbortSignal.timeout(ms) })` and reads the body with
//! `readBoundedJson`. Rust has no HTTP stack of its own (D13 of 0057 adds no client crate):
//! [`CurlClient`] sends the request through `curl` on the [`ProcessRunner`] of R76, and
//! [`RecordedHttp`] answers tests from fixed responses. Either way the caller sees what
//! `readBoundedJson` returns: the parsed body of a 2xx response within its byte cap, or nothing.

use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use crate::js_json::{self, JsValue};
use crate::process::{Env, Failure, ProcessRunner, Request};

/// One `GET`.
#[derive(Debug, Clone, Copy)]
pub struct HttpRequest<'a> {
    /// Absolute `https` URL.
    pub url: &'a str,
    /// Request headers, in order.
    pub headers: &'a [(&'a str, &'a str)],
    /// `AbortSignal.timeout(ms)`: the whole request, body included.
    pub timeout: Duration,
    /// `readBoundedJson`'s `maxBytes`.
    pub max_bytes: usize,
}

/// A response that arrived.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    /// Status code.
    pub status: u16,
    /// Body bytes.
    pub body: Vec<u8>,
}

/// Why no response arrived.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpFailure {
    /// Offline, DNS, TLS, a refused connection, or no client to send it.
    Error,
    /// The timeout fired.
    Timeout,
}

/// The transport.
pub trait HttpClient {
    /// Sends `request`.
    ///
    /// # Errors
    /// [`HttpFailure`] when no response arrived.
    fn get(&self, request: &HttpRequest<'_>) -> Result<HttpResponse, HttpFailure>;
}

/// `readBoundedJson(await fetch(...), maxBytes)` inside the callers' `try`: `None` for a failed
/// request, a non-2xx status, an empty or oversized body, or a body `JSON.parse` rejects.
#[must_use]
pub fn get_json(client: &dyn HttpClient, request: &HttpRequest<'_>) -> Option<JsValue> {
    let response = client.get(request).ok()?;
    if !(200..300).contains(&response.status)
        || response.body.is_empty()
        || response.body.len() > request.max_bytes
    {
        return None;
    }
    // `TextDecoder` replaces invalid UTF-8, as `from_utf8_lossy` does.
    js_json::parse(&String::from_utf8_lossy(&response.body))
}

/// `curl`'s exit code for "operation timed out".
const CURL_TIMEOUT: i32 = 28;
/// Marks the status code `--write-out` appends after the body.
const STATUS_MARK: &str = "\nnavori-http-status:";

/// The real transport: `curl` through a [`ProcessRunner`], following redirects like `fetch`.
pub struct CurlClient<'a> {
    /// Runs `curl`.
    pub runner: &'a dyn ProcessRunner,
    /// The child's environment (`PATH` finds `curl`; proxies and CA settings pass through).
    pub env: &'a Env,
    /// Working directory of the child.
    pub cwd: &'a Path,
}

impl HttpClient for CurlClient<'_> {
    fn get(&self, request: &HttpRequest<'_>) -> Result<HttpResponse, HttpFailure> {
        let seconds = format!("{:.3}", request.timeout.as_secs_f64());
        let write_out = format!("{STATUS_MARK}%{{http_code}}");
        let headers: Vec<String> = request
            .headers
            .iter()
            .map(|(name, value)| format!("{name}: {value}"))
            .collect();
        let mut args: Vec<&str> = vec![
            "--silent",
            "--location",
            "--max-time",
            &seconds,
            "--write-out",
            &write_out,
        ];
        for header in &headers {
            args.extend(["--header", header]);
        }
        args.push(request.url);
        // The child's own budget is a backstop: `--max-time` ends it first.
        let output = self
            .runner
            .run(&Request {
                program: "curl",
                args: &args,
                cwd: self.cwd,
                env: self.env,
                input: None,
                timeout: request.timeout + Duration::from_secs(1),
            })
            .map_err(|failure| match failure {
                Failure::Timeout => HttpFailure::Timeout,
                Failure::Spawn(_) => HttpFailure::Error,
            })?;
        match output.status.code() {
            Some(0) => {}
            Some(CURL_TIMEOUT) => return Err(HttpFailure::Timeout),
            _ => return Err(HttpFailure::Error),
        }
        let text = output.stdout;
        let mark = STATUS_MARK.as_bytes();
        let at = text
            .windows(mark.len())
            .rposition(|w| w == mark)
            .ok_or(HttpFailure::Error)?;
        let status = std::str::from_utf8(&text[at + mark.len()..])
            .ok()
            .and_then(|code| code.trim().parse::<u16>().ok())
            .ok_or(HttpFailure::Error)?;
        Ok(HttpResponse {
            status,
            body: text[..at].to_vec(),
        })
    }
}

/// A request [`RecordedHttp`] received: URL and headers.
pub type HttpCall = (String, Vec<(String, String)>);

/// Fixed answers by URL, for tests; every request is kept. A URL without an answer fails.
#[derive(Debug, Default)]
pub struct RecordedHttp {
    answers: Vec<(String, Result<HttpResponse, HttpFailure>)>,
    calls: Mutex<Vec<HttpCall>>,
}

impl RecordedHttp {
    /// A client over `answers`.
    #[must_use]
    pub fn new(answers: Vec<(String, Result<HttpResponse, HttpFailure>)>) -> Self {
        Self {
            answers,
            calls: Mutex::new(Vec::new()),
        }
    }

    /// Every request so far: URL and headers.
    #[must_use]
    pub fn calls(&self) -> Vec<HttpCall> {
        self.calls.lock().map(|c| c.clone()).unwrap_or_default()
    }
}

impl HttpClient for RecordedHttp {
    fn get(&self, request: &HttpRequest<'_>) -> Result<HttpResponse, HttpFailure> {
        if let Ok(mut calls) = self.calls.lock() {
            calls.push((
                request.url.to_owned(),
                request
                    .headers
                    .iter()
                    .map(|(n, v)| ((*n).to_owned(), (*v).to_owned()))
                    .collect(),
            ));
        }
        self.answers
            .iter()
            .find(|(url, _)| url == request.url)
            .map_or(Err(HttpFailure::Error), |(_, answer)| answer.clone())
    }
}
