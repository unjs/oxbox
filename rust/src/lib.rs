// `#[napi]` items register themselves via exported `__napi_register__*` symbols, so linking the crates is enough
pub use oxc_parser_napi::*;
pub use oxc_transform_napi::*;
