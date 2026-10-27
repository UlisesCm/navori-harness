//! zod 4 semantics over [`JsValue`]: the primitives `config` and the preset/plugin manifests
//! share (spec 0058 D22). A failed check is [`Invalid`]; the callers turn it into a re-delegation.

#![allow(dead_code, reason = "primitives are adopted schema by schema")]

use crate::js_json::{JsObject, JsValue};

/// zod would report at least one issue.
pub(crate) struct Invalid;
pub(crate) type Parsed = Result<JsValue, Invalid>;

pub(crate) fn object(value: &JsValue) -> Result<&JsObject, Invalid> {
    match value {
        JsValue::Object(object) => Ok(object),
        _ => Err(Invalid),
    }
}

pub(crate) fn text(value: &JsValue) -> Result<String, Invalid> {
    match value {
        JsValue::String(text) => text.to_rust().ok_or(Invalid),
        _ => Err(Invalid),
    }
}

pub(crate) fn string(value: &JsValue) -> Parsed {
    text(value).map(|_| value.clone())
}

pub(crate) fn non_empty(value: &JsValue) -> Parsed {
    let content = text(value)?;
    if content.is_empty() {
        return Err(Invalid);
    }
    Ok(value.clone())
}

pub(crate) fn boolean(value: &JsValue) -> Parsed {
    match value {
        JsValue::Bool(_) => Ok(value.clone()),
        _ => Err(Invalid),
    }
}

pub(crate) fn one_of(value: &JsValue, allowed: &[&str]) -> Parsed {
    let content = text(value)?;
    if allowed.contains(&content.as_str()) {
        Ok(value.clone())
    } else {
        Err(Invalid)
    }
}

/// `z.number().int().min(min)`: finite, a safe integer, at least `min`.
pub(crate) fn safe_integer_at_least(value: &JsValue, min: f64) -> Parsed {
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    match value {
        JsValue::Number(n) if n.fract() == 0.0 && n.abs() <= MAX_SAFE && *n >= min => {
            Ok(value.clone())
        }
        _ => Err(Invalid),
    }
}

pub(crate) fn array_of(value: &JsValue, item: fn(&JsValue) -> Parsed) -> Parsed {
    match value {
        JsValue::Array(items) => items
            .iter()
            .map(item)
            .collect::<Result<Vec<_>, _>>()
            .map(JsValue::Array),
        _ => Err(Invalid),
    }
}

pub(crate) fn strings(value: &JsValue) -> Parsed {
    array_of(value, string)
}

pub(crate) fn non_empty_strings(value: &JsValue) -> Parsed {
    array_of(value, non_empty)
}

pub(crate) fn empty_array() -> JsValue {
    JsValue::Array(Vec::new())
}

/// Builds one `z.object` output: shape keys in order, then (passthrough) the rest.
pub(crate) struct Shape<'a> {
    input: &'a JsObject,
    output: JsObject,
    known: Vec<&'static str>,
}

impl<'a> Shape<'a> {
    pub(crate) fn new(value: &'a JsValue) -> Result<Self, Invalid> {
        Ok(Self {
            input: object(value)?,
            output: JsObject::new(),
            known: Vec::new(),
        })
    }

    /// `.optional()`: absent stays absent.
    pub(crate) fn optional(
        mut self,
        key: &'static str,
        parse: impl Fn(&JsValue) -> Parsed,
    ) -> Result<Self, Invalid> {
        self.known.push(key);
        if let Some(value) = self.input.get(key) {
            self.output.insert(key, parse(value)?);
        }
        Ok(self)
    }

    /// Required: an absent key is parsed as `undefined`.
    pub(crate) fn required(
        mut self,
        key: &'static str,
        parse: impl Fn(&JsValue) -> Parsed,
    ) -> Result<Self, Invalid> {
        self.known.push(key);
        let value = self.input.get(key).unwrap_or(&JsValue::Undefined);
        self.output.insert(key, parse(value)?);
        Ok(self)
    }

    /// `.default(fallback)`: zod 4 returns the default without parsing it.
    pub(crate) fn defaulted(
        mut self,
        key: &'static str,
        fallback: JsValue,
        parse: impl Fn(&JsValue) -> Parsed,
    ) -> Result<Self, Invalid> {
        self.known.push(key);
        let value = match self.input.get(key) {
            Some(value) => parse(value)?,
            None => fallback,
        };
        self.output.insert(key, value);
        Ok(self)
    }

    /// Plain `z.object`: unknown keys are dropped.
    pub(crate) fn strip(self) -> JsValue {
        JsValue::Object(self.output)
    }

    /// `.passthrough()`: unknown keys follow the shape keys, in input order.
    pub(crate) fn passthrough(mut self) -> JsValue {
        for (key, value) in self.input.entries() {
            if !self.known.iter().any(|known| key.is(known)) {
                self.output.insert(key.clone(), value.clone());
            }
        }
        JsValue::Object(self.output)
    }

    /// `.strict()`: unknown keys are an issue.
    pub(crate) fn strict(self) -> Parsed {
        let extra = self
            .input
            .entries()
            .iter()
            .any(|(key, _)| !self.known.iter().any(|known| key.is(known)));
        if extra {
            Err(Invalid)
        } else {
            Ok(JsValue::Object(self.output))
        }
    }
}

pub(crate) fn kebab(value: &JsValue) -> Parsed {
    let content = text(value)?;
    let mut bytes = content.bytes();
    let first_ok = bytes
        .next()
        .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    let rest_ok = bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if first_ok && rest_ok {
        Ok(value.clone())
    } else {
        Err(Invalid)
    }
}

/// `safeRelPath`: non-empty, not absolute, no `..` segment split on `/` or `\`.
pub(crate) fn safe_rel_path(value: &JsValue) -> Parsed {
    let content = text(value)?;
    if content.is_empty()
        || content.starts_with('/')
        || content.split(['/', '\\']).any(|segment| segment == "..")
    {
        return Err(Invalid);
    }
    Ok(value.clone())
}
