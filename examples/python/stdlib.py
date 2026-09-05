import os
from collections import Counter
words = os.environ.get("WORDS", "hello,world,hello").split(",")
counts = Counter(words)
print("Counting words with the standard library")
{"counts": dict(counts), "mean_length": sum(map(len, words)) / len(words)}
