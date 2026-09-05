from collections import Counter
counts = Counter(input["words"])
print("Counting words with the standard library")
return {"counts": dict(counts), "mean_length": sum(map(len, input["words"])) / len(input["words"])}
