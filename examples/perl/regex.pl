my @words = split /,/, ($ENV{WORDS} // "hello,world,hello,perl");
my $text = join(" ", @words);
my @matches = $text =~ /\b\w+\b/g;
my %counts;
$counts{lc $_}++ for @matches;
print "Parsed ", scalar(@matches), " words\n";
\%counts;
