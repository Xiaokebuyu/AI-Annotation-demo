# 默认无混淆（release isMinifyEnabled=false）。若日后开混淆，保留 POC 的 OCR 类与 ML Kit。
-keep class com.example.hmpocrpoc.** { *; }
-keep class com.paddle.ocr.** { *; }
